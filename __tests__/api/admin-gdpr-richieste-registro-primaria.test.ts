import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// IL REGISTRO DELLA PRIMARIA NON SI ANONIMIZZA, NEMMENO DA QUI (titolare,
// 2026-10-08 · scelta B del 2026-10-09).
//
// Questa route evade la richiesta di cancellazione del GENITORE e anonimizza in
// blocco i suoi figli non più iscritti. Un figlio con voti, pagelle, scrutini,
// note o certificati delle competenze si SALTA — come già si fa con i figli
// iscritti — e il resto prosegue: l'eccezione dell'art. 17 §3 lett. b copre il
// registro del minore, non i dati del genitore né quelli degli altri figli.
//
// Vincoli provati qui:
//   · nessun `anonimizzaAlunno` su un bambino con il registro;
//   · `alunni_registro_primaria` coerente fra GET, dry-run, execute, esito
//     salvato sulla richiesta e audit;
//   · un `logEvento('gdpr','warn', …)` per ogni bambino saltato;
//   · lettura del registro fallita → 500 PRIMA di ogni scrittura, richiesta che
//     resta `pending`.
//
// `anonimizzaAlunno`/`anonimizzaParent` sono finte (come in
// `admin-gdpr-richieste-route.test.ts`): qui interessa CHI le riceve.
// =============================================================================

const PARENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-parent000001'
const AL_LIBERO = 'a1b2c3d4-0000-4000-8000-00000000a001'
const AL_REGISTRO = 'a1b2c3d4-0000-4000-8000-00000000a002'
const AL_ISCRITTO = 'a1b2c3d4-0000-4000-8000-00000000a003'
const OP = 'admin/gdpr/richieste:POST'
const AUTH_GENITORE = 'cccccccc-cccc-4ccc-8ccc-account00001'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaParent: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  // Le righe di ogni tabella, per nome. I filtri `eq` si APPLICANO sulle
  // colonne che la riga possiede: così il registro di un figlio non contagia
  // gli altri, e i conteggi del dry-run restano per bambino.
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message: string }>,
  updates: [] as { table: string; patch: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      const righe = () =>
        (h.db[table] ?? []).filter((r) =>
          Object.entries(filtri).every(([col, val]) => !(col in r) || r[col] === val),
        )
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'is', 'neq', 'or', 'order', 'range', 'contains', 'not', 'limit']) {
        b[m] = () => b
      }
      b.eq = (col: string, val: unknown) => { filtri[col] = val; return b }
      b.update = (patch: Record<string, unknown>) => { h.updates.push({ table, patch }); return b }
      b.maybeSingle = async () => {
        if (h.errori[table]) return { data: null, error: h.errori[table] }
        return { data: righe()[0] ?? null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => {
        if (h.errori[table]) return Promise.resolve({ data: null, error: h.errori[table] }).then(res)
        return Promise.resolve({ data: righe(), error: null }).then(res)
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/admin/gdpr/richieste/route'

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/admin/gdpr/richieste', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
const get = () => GET(new NextRequest('http://localhost/api/admin/gdpr/richieste'))
const esegui = () => post({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' })
const dryrun = () => post({ id: 'req-1', mode: 'dryrun' })

const figlio = (id: string, stato: string, documento_path: string | null = null) => ({
  id, stato, anonimizzato_il: null, scuola_id: SEDE_A, documento_path, codice_fiscale: null, fiscal_code: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_A } })
  h.db = {
    richieste_cancellazione: [
      { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SEDE_A, creata_il: '2026-10-01T08:00:00Z' },
    ],
    parents: [{ id: PARENT_ID, first_name: 'Genitore', last_name: 'DiProva', documento_path: null, auth_user_id: AUTH_GENITORE }],
    student_parents: [
      { parent_id: PARENT_ID, student_id: AL_LIBERO },
      { parent_id: PARENT_ID, student_id: AL_REGISTRO },
      { parent_id: PARENT_ID, student_id: AL_ISCRITTO },
    ],
    alunni: [
      figlio(AL_LIBERO, 'ritirato', 'doc/libero.pdf'),
      figlio(AL_REGISTRO, 'ritirato', 'doc/registro.pdf'),
      figlio(AL_ISCRITTO, 'iscritto'),
    ],
    // Il registro: un voto del secondo figlio. Anche il figlio ISCRITTO ha un
    // voto, e deve restare contato fra gli iscritti mantenuti — le quattro voci
    // (anonimizzati, registro, iscritti, fuori sede) sono una PARTIZIONE.
    valutazioni: [{ alunno_id: AL_REGISTRO }, { alunno_id: AL_ISCRITTO }],
    // Ciò che il dry-run conta, per bambino: il figlio col registro NON si somma.
    certificati_medici: [{ id: 'cm-1', alunno_id: AL_LIBERO }, { id: 'cm-2', alunno_id: AL_REGISTRO }, { id: 'cm-3', alunno_id: AL_REGISTRO }],
  }
  h.errori = {}
  h.updates = []
  // Con un figlio che resta (registro, o ancora iscritto) l'account del genitore non
  // si libera: è ciò che `anonimizzaParent` risponde davvero in quel caso.
  h.anonimizzaParent.mockResolvedValue({
    newsVisualizzazioniRimosse: 0, segnalazioniBonificate: 0, sospensioniBonificate: 0, account: 'non-toccato-figli-vivi',
  })
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0, segnalazioniBonificate: 0, sospensioniBonificate: 0,
  })
})

const righeRegistro = () =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === 'oblio-rifiutato-registro-primaria')

describe('POST /api/admin/gdpr/richieste — il figlio col registro della primaria si salta', () => {
  it('dryrun: il figlio col registro è contato a parte e NON entra nei conteggi di ciò che si distrugge', async () => {
    const res = await dryrun()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({
      alunni_non_iscritti: 1,
      alunni_registro_primaria: 1,
      alunni_iscritti_mantenuti: 1,
      alunni_fuori_scope: 0,
    })
    // Un certificato del figlio anonimizzato, non i due di quello che resta.
    expect(j.certificati_medici).toBe(1)
    // Il documento d'identità del figlio col registro non esce dal bucket.
    expect(j.file_da_rimuovere).toBe(1)
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
  })

  it('execute: anonimizzaAlunno MAI sul figlio col registro; il genitore e l’altro figlio sì', async () => {
    const res = await esegui()
    expect(res.status).toBe(200)
    const ids = h.anonimizzaAlunno.mock.calls.map((c) => (c[1] as { id: string }).id)
    expect(ids).toEqual([AL_LIBERO])
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    const j = await res.json()
    expect(j).toMatchObject({ alunni: 1, alunni_registro_primaria: 1 })
  })

  it('execute: l’esito SALVATO sulla richiesta e l’audit dicono quanti figli sono stati esclusi', async () => {
    await esegui()
    const upd = h.updates.find((u) => u.table === 'richieste_cancellazione')
    expect(upd!.patch).toMatchObject({ stato: 'evasa' })
    expect((upd!.patch.esito as Record<string, unknown>).alunni_registro_primaria).toBe(1)
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo.alunni_registro_primaria).toBe(1)
  })

  it('execute: un log `warn` per OGNI bambino saltato, con il suo uuid e senza nomi', async () => {
    h.db.alunni.push(figlio('a1b2c3d4-0000-4000-8000-00000000a004', 'ritirato'))
    h.db.student_parents.push({ parent_id: PARENT_ID, student_id: 'a1b2c3d4-0000-4000-8000-00000000a004' })
    h.db.note_disciplinari = [{ alunno_id: 'a1b2c3d4-0000-4000-8000-00000000a004' }]
    await esegui()
    const righe = righeRegistro()
    expect(righe).toHaveLength(2)
    for (const r of righe) {
      expect(r[0]).toBe('gdpr')
      expect(r[1]).toBe('warn')
      expect(r[2]).toMatchObject({ operazione: OP, entita_tipo: 'alunni' })
    }
    expect(righe.map((r) => (r[2] as { entita_id: string }).entita_id).sort()).toEqual(
      [AL_REGISTRO, 'a1b2c3d4-0000-4000-8000-00000000a004'].sort(),
    )
    expect(JSON.stringify(righe)).not.toMatch(/Genitore|DiProva/)
  })

  it('execute: se l’UNICO figlio non iscritto ha il registro, nessun minore si tocca e il genitore sì', async () => {
    h.db.alunni = [figlio(AL_REGISTRO, 'ritirato')]
    h.db.student_parents = [{ parent_id: PARENT_ID, student_id: AL_REGISTRO }]
    const res = await esegui()
    expect(res.status).toBe(200)
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    expect(await res.json()).toMatchObject({ alunni: 0, alunni_registro_primaria: 1 })
  })

  it('lettura del registro FALLITA → 500 PRIMA di ogni scrittura: la richiesta resta in attesa', async () => {
    h.errori = { note_disciplinari: { code: '57014', message: 'timeout' } }
    const res = await esegui()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('GDPR_ERASE_NON_RIUSCITO')
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('lettura del registro FALLITA ferma anche il dry-run: un conteggio inventato è una conferma inventata', async () => {
    h.errori = { scrutinio_giudizi: { code: '42501', message: 'permission denied' } }
    const res = await dryrun()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('GDPR_ERASE_NON_RIUSCITO')
  })

  it('controllo: senza registro il comportamento non cambia (tutti i non iscritti, zero esclusi)', async () => {
    h.db.valutazioni = []
    const res = await esegui()
    expect(res.status).toBe(200)
    const ids = h.anonimizzaAlunno.mock.calls.map((c) => (c[1] as { id: string }).id).sort()
    expect(ids).toEqual([AL_LIBERO, AL_REGISTRO].sort())
    expect(await res.json()).toMatchObject({ alunni: 2, alunni_registro_primaria: 0 })
    expect(righeRegistro()).toEqual([])
  })
})

describe('GET /api/admin/gdpr/richieste — lo stesso conteggio dell’elenco', () => {
  it('GET, dry-run, execute, esito salvato e audit dicono lo STESSO numero', async () => {
    const elenco = (await (await get()).json()) as Record<string, unknown>[]
    expect(elenco[0]).toMatchObject({ alunni_non_iscritti: 1, alunni_registro_primaria: 1, alunni_iscritti: 1 })

    const dry = await (await dryrun()).json()
    const ese = await (await esegui()).json()
    const salvato = h.updates.find((u) => u.table === 'richieste_cancellazione')!.patch.esito as Record<string, unknown>
    const audit = (h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }).valoreDopo

    for (const n of [dry.alunni_registro_primaria, ese.alunni_registro_primaria, salvato.alunni_registro_primaria, audit.alunni_registro_primaria]) {
      expect(n).toBe(elenco[0].alunni_registro_primaria)
    }
    expect(dry.alunni_non_iscritti).toBe(elenco[0].alunni_non_iscritti)
    expect(ese.alunni).toBe(elenco[0].alunni_non_iscritti)
  })

  it('GET: una lettura del registro fallita non nasconde la richiesta, e il numero è «non misurato» (null)', async () => {
    h.errori = { note_disciplinari: { code: '57014', message: 'timeout' } }
    const res = await get()
    expect(res.status).toBe(200)
    const elenco = (await res.json()) as Record<string, unknown>[]
    expect(elenco).toHaveLength(1)
    expect(elenco[0].alunni_registro_primaria).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr', 'warn', expect.objectContaining({ esito: 'registro-primaria-non-letto', richiesta: 'req-1' }), expect.anything(),
    )
  })
})

// =============================================================================
// L'ACCOUNT DEL GENITORE RESTA, E VA DETTO (revisione del 2026-10-09).
//
// Con un figlio che non si anonimizza — registro da conservare, o ancora
// iscritto — `anonimizzaParent` anonimizza la SCHEDA del genitore ma lascia il suo
// account di accesso (email e nome) con l'esito `non-toccato-figli-vivi`. Il
// dry-run diceva «il genitore si anonimizza lo stesso», e basta. Quando
// l'account si cancella è una decisione del titolare e NON cambia qui: qui si
// rende VISIBILE, con `account_mantenuti` (0/1 per richiesta) nel dry-run, nella
// risposta, nell'esito salvato e nell'audit.
// =============================================================================
describe('POST /api/admin/gdpr/richieste — l’account del genitore che resta', () => {
  /** Toglie il figlio ancora iscritto (il finto non applica `.in`, quindi da entrambe le tabelle). */
  const senzaIscritto = () => {
    h.db.student_parents = h.db.student_parents.filter((l) => l.student_id !== AL_ISCRITTO)
    h.db.alunni = h.db.alunni.filter((a) => a.id !== AL_ISCRITTO)
  }

  it('dryrun: un figlio col registro tiene in vita l’account → account_mantenuti 1', async () => {
    senzaIscritto()
    const j = await (await dryrun()).json()
    expect(j).toMatchObject({ alunni_registro_primaria: 1, alunni_iscritti_mantenuti: 0, account_mantenuti: 1 })
  })

  it('dryrun: anche un figlio ancora ISCRITTO tiene in vita l’account', async () => {
    h.db.valutazioni = []
    const j = await (await dryrun()).json()
    expect(j).toMatchObject({ alunni_registro_primaria: 0, alunni_iscritti_mantenuti: 1, account_mantenuti: 1 })
  })

  it('dryrun: tutti i figli anonimizzati → account_mantenuti 0', async () => {
    h.db.valutazioni = []
    senzaIscritto()
    expect((await (await dryrun()).json()).account_mantenuti).toBe(0)
  })

  it('dryrun: un genitore SENZA account non ha un account che resta', async () => {
    h.db.parents = [{ ...h.db.parents[0], auth_user_id: null }]
    expect((await (await dryrun()).json()).account_mantenuti).toBe(0)
  })

  it('dryrun: scheda del genitore non letta → account_mantenuti «non misurato» (null), non 0', async () => {
    h.errori = { parents: { code: '42501', message: 'permission denied' } }
    expect((await (await dryrun()).json()).account_mantenuti).toBeNull()
  })

  it('execute: account_mantenuti nella risposta, nell’esito SALVATO e nell’audit', async () => {
    const j = await (await esegui()).json()
    expect(j.account_mantenuti).toBe(1)
    const salvato = h.updates.find((u) => u.table === 'richieste_cancellazione')!.patch.esito as Record<string, unknown>
    expect(salvato.account_mantenuti).toBe(1)
    const audit = (h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }).valoreDopo
    expect(audit.account_mantenuti).toBe(1)
  })

  it('execute: account liberato davvero → account_mantenuti 0', async () => {
    h.anonimizzaParent.mockResolvedValue({
      newsVisualizzazioniRimosse: 0, segnalazioniBonificate: 0, sospensioniBonificate: 0, account: 'rimosso',
    })
    expect((await (await esegui()).json()).account_mantenuti).toBe(0)
  })
})

describe('GET /api/admin/gdpr/richieste — il registro non letto è «non misurato», mai zero', () => {
  it('legami non letti → alunni_registro_primaria null', async () => {
    h.errori = { student_parents: { code: '42501', message: 'permission denied' } }
    const elenco = (await (await get()).json()) as Record<string, unknown>[]
    expect(elenco[0].alunni_registro_primaria).toBeNull()
  })

  it('figli non letti → alunni_registro_primaria null', async () => {
    h.errori = { alunni: { code: '42501', message: 'permission denied' } }
    const elenco = (await (await get()).json()) as Record<string, unknown>[]
    expect(elenco[0].alunni_registro_primaria).toBeNull()
  })
})
