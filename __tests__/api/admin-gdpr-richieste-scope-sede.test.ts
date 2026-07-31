import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// F5 — l'evasione di una richiesta di cancellazione NON deve uscire dalla sede.
//
// `POST /api/admin/gdpr/richieste` verificava la sede DELLA RICHIESTA (corretto)
// e poi raccoglieva i figli del genitore da `student_parents` SENZA alcun filtro
// di sede, chiamando `anonimizzaAlunno` su tutti i non iscritti. Una Direzione di
// plesso poteva quindi rendere IRREVERSIBILMENTE anonimo un minore di un altro
// plesso — e cancellarne il documento d'identità dallo storage — senza che la
// Direzione competente lo vedesse mai. Non esiste un annulla.
//
// La route gemella `admin/gdpr/erase` fa `assertAlunnoInScope` proprio per
// questo: le due strade divergevano sull'operazione più grave dell'applicazione.
//
// Il fake qui sotto onora DAVVERO `.eq()` e `.in()`: è l'unico modo perché un
// figlio di un'altra sede sia distinguibile da uno della propria. Il file di test
// storico (`admin-gdpr-richieste-route.test.ts`) monta un solo `SEDE_A` e un fake
// che ignora le colonne — ed è il motivo per cui il difetto non era mai emerso.
// =============================================================================

const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'
const DIRETTORE_ID = 'cccccccc-cccc-cccc-cccc-direttore001'

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const h = vi.hoisted(() => {
  const state = {
    richiesta: null as Riga | null,
    tabelle: {} as Record<string, Riga[]>,
    updates: [] as Array<{ table: string; patch: Riga }>,
  }
  const requireStaff = vi.fn()
  const logScrittura = vi.fn()
  const anonimizzaParent = vi.fn()
  const anonimizzaAlunno = vi.fn()
  const logEvento = vi.fn()
  const logErrore = vi.fn()
  const logOk = vi.fn()
  return { state, requireStaff, logScrittura, anonimizzaParent, anonimizzaAlunno, logEvento, logErrore, logOk }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: h.logOk,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Filtro[] = []
      let patch: Riga | null = null
      const righe = () =>
        (h.state.tabelle[table] ?? []).filter((r) =>
          filtri.every((f) => f.vals.some((v) => r[f.col] === v)),
        )
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.update = (v: Riga) => { patch = v; return b }
      b.maybeSingle = async () =>
        table === 'richieste_cancellazione'
          ? { data: h.state.richiesta, error: null }
          : { data: righe()[0] ?? null, error: null }
      b.then = (res: (v: unknown) => unknown) => {
        if (patch) h.state.updates.push({ table, patch })
        return Promise.resolve({ data: righe(), error: null }).then(res)
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/admin/gdpr/richieste/route'

const URL_ROUTE = 'http://localhost/api/admin/gdpr/richieste'
const post = (body: unknown, cookie?: string) =>
  new NextRequest(URL_ROUTE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie: `sedi_attive=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  })
const get = (cookie?: string) =>
  new NextRequest(URL_ROUTE, { headers: cookie ? { cookie: `sedi_attive=${cookie}` } : {} })

const alunno = (id: string, sede: string | null, stato = 'non_iscritto'): Riga => ({
  id,
  stato,
  anonimizzato_il: null,
  scuola_id: sede,
  documento_path: null,
  codice_fiscale: null,
  fiscal_code: null,
})

const esegui = (body: Riga = {}) => POST(post({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA', ...body }))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: DIRETTORE_ID, role: 'admin', scuola_id: SEDE_A } })
  h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SEDE_A }
  h.state.tabelle = {
    richieste_cancellazione: [{ id: 'req-1', parent_id: PARENT_ID, creata_il: '2026-07-31T08:00:00Z', scuola_id: SEDE_A, stato: 'pending' }],
    utenti_scuole: [],
    student_parents: [],
    alunni: [],
    parents: [{ id: PARENT_ID, first_name: 'Prova', last_name: 'Prova' }],
  }
  h.state.updates = []
  h.anonimizzaParent.mockResolvedValue({
    newsVisualizzazioniRimosse: 0, segnalazioniBonificate: 0, sospensioniBonificate: 0,
  })
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0,
    segnalazioniBonificate: 0, sospensioniBonificate: 0,
  })
})

/** Genitore con un figlio nella sede della richiesta e uno in un ALTRO plesso. */
function figliInDueSedi() {
  h.state.tabelle.student_parents = [
    { parent_id: PARENT_ID, student_id: 'al-mio' },
    { parent_id: PARENT_ID, student_id: 'al-altrui' },
  ]
  h.state.tabelle.alunni = [alunno('al-mio', SEDE_A), alunno('al-altrui', SEDE_B)]
}

describe('POST /api/admin/gdpr/richieste — isolamento fra sedi dei FIGLI (F5)', () => {
  it('execute: anonimizza SOLO il figlio del proprio plesso, mai quello dell’altra sede', async () => {
    figliInDueSedi()
    const res = await esegui()
    expect(res.status).toBe(200)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect((h.anonimizzaAlunno.mock.calls[0][1] as { id: string }).id).toBe('al-mio')
    const idsToccati = h.anonimizzaAlunno.mock.calls.map((c) => (c[1] as { id: string }).id)
    expect(idsToccati).not.toContain('al-altrui')
  })

  it('execute: dichiara i figli rimasti FUORI SCOPE invece di tacerli', async () => {
    figliInDueSedi()
    const j = await (await esegui()).json()
    expect(j.alunni).toBe(1)
    expect(j.alunni_fuori_scope).toBe(1)
  })

  it('execute: i figli fuori scope lasciano una riga persistita (canale gdpr, warn)', async () => {
    figliInDueSedi()
    await esegui()
    const riga = h.logEvento.mock.calls.find(
      (c) => c[0] === 'gdpr' && (c[2] as { esito?: string })?.esito === 'figli-fuori-scope',
    )
    expect(riga).toBeTruthy()
    expect(riga![1]).toBe('warn')
    expect(riga![2]).toMatchObject({ n: 1 })
  })

  it('nessun figlio fuori scope → nessun rumore', async () => {
    h.state.tabelle.student_parents = [{ parent_id: PARENT_ID, student_id: 'al-mio' }]
    h.state.tabelle.alunni = [alunno('al-mio', SEDE_A)]
    await esegui()
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'figli-fuori-scope',
    )
    expect(riga).toBeUndefined()
  })

  it('il residuo resta scritto anche sull’esito della richiesta (chi la rilegge domani lo vede)', async () => {
    figliInDueSedi()
    await esegui()
    const upd = h.state.updates.find((u) => u.table === 'richieste_cancellazione')
    expect(upd!.patch).toMatchObject({ stato: 'evasa' })
    expect((upd!.patch.esito as Riga).alunni_fuori_scope).toBe(1)
  })

  it('un figlio SENZA sede sulla riga non si anonimizza (fail-closed)', async () => {
    h.state.tabelle.student_parents = [{ parent_id: PARENT_ID, student_id: 'al-orfano' }]
    h.state.tabelle.alunni = [alunno('al-orfano', null)]
    const j = await (await esegui()).json()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(j.alunni).toBe(0)
    expect(j.alunni_fuori_scope).toBe(1)
  })

  it('Direzione multi-plesso (utenti_scuole): entrambi i figli sono suoi, nessun residuo', async () => {
    figliInDueSedi()
    h.state.tabelle.utenti_scuole = [{ utente_id: DIRETTORE_ID, scuola_id: SEDE_B }]
    const j = await (await esegui()).json()
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(2)
    expect(j.alunni).toBe(2)
    expect(j.alunni_fuori_scope).toBe(0)
  })

  it('il cookie del SedeSelector NON decide chi viene anonimizzato per sempre', async () => {
    // Il selettore di sede è una preferenza di VISTA. La Direzione ha davvero
    // entrambi i plessi (utenti_scuole): che nella barra in alto abbia lasciato
    // spuntata solo la sede della richiesta non può togliere a un minore
    // dell'altro plesso l'oblio che il suo genitore ha chiesto — né trasformarlo
    // in un «residuo» che nessuno evaderà, visto che la richiesta si chiude qui.
    figliInDueSedi()
    h.state.tabelle.utenti_scuole = [{ utente_id: DIRETTORE_ID, scuola_id: SEDE_B }]
    const res = await POST(post({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }, SEDE_A))
    const j = await res.json()
    expect(j.alunni).toBe(2)
    expect(j.alunni_fuori_scope).toBe(0)
  })

  it('dryrun: il conteggio mostrato è quello che verrà davvero eseguito', async () => {
    figliInDueSedi()
    const j = await (await POST(post({ id: 'req-1', mode: 'dryrun' }))).json()
    expect(j).toMatchObject({ dryrun: true, alunni_non_iscritti: 1, alunni_fuori_scope: 1 })
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('un figlio ISCRITTO dell’altra sede non è né anonimizzato né contato come mantenuto qui', async () => {
    h.state.tabelle.student_parents = [
      { parent_id: PARENT_ID, student_id: 'al-mio' },
      { parent_id: PARENT_ID, student_id: 'al-altrui' },
    ]
    h.state.tabelle.alunni = [alunno('al-mio', SEDE_A, 'iscritto'), alunno('al-altrui', SEDE_B, 'iscritto')]
    const j = await (await POST(post({ id: 'req-1', mode: 'dryrun' }))).json()
    expect(j.alunni_iscritti_mantenuti).toBe(1)
    expect(j.alunni_fuori_scope).toBe(1)
  })
})

describe('GET /api/admin/gdpr/richieste — i conteggi non parlano di altri plessi', () => {
  it('conta solo i figli del proprio scope e dichiara il residuo', async () => {
    figliInDueSedi()
    const j = await (await GET(get())).json()
    expect(j).toHaveLength(1)
    expect(j[0]).toMatchObject({ alunni_non_iscritti: 1, alunni_iscritti: 0, alunni_fuori_scope: 1 })
  })

  it('un figlio iscritto in un altro plesso non gonfia il conteggio degli iscritti', async () => {
    h.state.tabelle.student_parents = [{ parent_id: PARENT_ID, student_id: 'al-altrui' }]
    h.state.tabelle.alunni = [alunno('al-altrui', SEDE_B, 'iscritto')]
    const j = await (await GET(get())).json()
    expect(j[0]).toMatchObject({ alunni_iscritti: 0, alunni_non_iscritti: 0, alunni_fuori_scope: 1 })
  })
})
