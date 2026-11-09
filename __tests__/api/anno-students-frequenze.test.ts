import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// PR 3 · COMPITO 3.7-2 · le route `admin/students` collegate a `scriviFrequenza` (fase A, §4.19).
//
// Regola provata sito per sito: `alunni` scritto con successo E patch che tocca una colonna copiata →
// `scriviFrequenza` UNA volta, con i campi tradotti e l'anno attivo della sede giusta; `alunni` in errore → ZERO
// chiamate; patch senza colonne copiate → ZERO chiamate. La risposta della route non cambia se la frequenza fallisce.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_A2 = '11111111-1111-4111-8111-aaaaaaaaaaa2'
const ALU_B = '11111111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_R = '11111111-1111-4111-8111-cccccccccccc'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scriviFrequenza: vi.fn(),
  logScrittura: vi.fn(async () => undefined),
  annoAttivoDiSede: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  sparisceDopoLoScope: null as string | null,
  logErrore: vi.fn(),
  riallineaImporto: vi.fn(async () => undefined),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
  annoAttivoDiSede: h.annoAttivoDiSede,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/pagamenti/scadenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/pagamenti/scadenze')>()),
  riallineaImportoRetteFuture: h.riallineaImporto,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // `errori` è una vista VIVA su `h.errori`: un test può iniettare un guasto DOPO la creazione del client (per esempio dentro il
  // mock di `scriviFrequenza`, per modellare «la frequenza si scrive e poi alunni fallisce»).
  const vivi = new Proxy({} as Record<string, { code: string; message?: string }>, {
    get: (_t, k) => h.errori[k as string],
    has: (_t, k) => k in h.errori,
    ownKeys: () => Reflect.ownKeys(h.errori),
    getOwnPropertyDescriptor: (_t, k) => (k in h.errori ? { enumerable: true, configurable: true, value: h.errori[k as string] } : undefined),
  })
  const opzioni = () => ({ scritture: h.scritture as Scrittura[], errori: vivi })
  // Corsa: `sparisceDopoLoScope` toglie una riga dal db fra la lettura dello scope (1ª lettura di `alunni`) e l'UPDATE.
  const conCorsa = (c: ReturnType<typeof creaFintoSupabase>) => {
    let letture = 0
    const from = c.from.bind(c)
    c.from = ((tabella: string) => {
      if (tabella === 'alunni' && h.sparisceDopoLoScope && ++letture === 2) {
        h.db.alunni = h.db.alunni.filter((r) => r.id !== h.sparisceDopoLoScope)
      }
      return from(tabella)
    }) as typeof c.from
    return c
  }
  return {
    createAdminClient: async () => conCorsa(creaFintoSupabase(h.db, h.tabelle, opzioni())),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, opzioni()),
  }
})

import { POST as CREA, PATCH } from '@/app/api/admin/students/route'
import { POST as ARCHIVIA } from '@/app/api/admin/students/archivia/route'
import { POST as RIATTIVA } from '@/app/api/admin/students/riattiva/route'

const req = (metodo: string, percorso: string) => (body: unknown) =>
  new NextRequest(`http://localhost${percorso}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const crea = req('POST', '/api/admin/students')
const patch = req('PATCH', '/api/admin/students')
const archivia = req('POST', '/api/admin/students/archivia')
const riattiva = req('POST', '/api/admin/students/riattiva')

const alunno = (id: string, sede: string, sezione: string) => ({
  id, nome: 'Prova', cognome: 'Finto', scuola_id: sede, section_id: sezione, classe_sezione: '2 ANNI',
  stato: 'iscritto', archiviato_il: null, gruppo_mensa_id: null, usa_pannolino: false,
})

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: 'Sede A' }, { id: SEDE_B, nome: 'Sede B' }],
  scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
  utenti_scuole: [{ utente_id: 'adm-1', scuola_id: SEDE_A }, { utente_id: 'adm-1', scuola_id: SEDE_B }],
  utenti_sezioni: [],
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI', anno_id: 'y1' },
    { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI', anno_id: 'y1' },
  ],
  anni_sede: [
    { id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' },
    { id: `anno-di-${SEDE_B}`, scuola_id: SEDE_B, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' },
  ],
  gruppi_mensa: [],
  // (giro 1, B7) Chi si riporta fra gli iscritti ha una frequenza nell'anno in corso (chiusa il giorno dell'archiviazione, quindi
  // conta): senza, la route rifiuta con ALUNNO_SENZA_ISCRIZIONE (provato in coda a questo file).
  frequenze: [
    { id: 'fr-r', alunno_id: ALU_R, anno_sede_id: `anno-di-${SEDE_A}`, stato: 'ritirato', data_uscita: '2026-08-01' },
  ],
  alunni: [
    alunno(ALU_A, SEDE_A, SEC_A),
    alunno(ALU_A2, SEDE_A, SEC_A),
    alunno(ALU_B, SEDE_B, SEC_B),
    {
      ...alunno(ALU_R, SEDE_A, SEC_A), section_id: null, classe_sezione: null, stato: 'ritirato',
      archiviato_il: '2026-08-01T10:00:00.000Z', archiviato_da: 'adm-1', archiviato_motivo: 'ritiro',
      archiviato_section_id: SEC_A, archiviato_classe_sezione: '2 ANNI', spazio_liberato_il: null,
    },
  ],
  parents: [],
  student_parents: [],
  legame_genitori_alunni: [],
  utenti: [],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.sparisceDopoLoScope = null
  h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
  h.annoAttivoDiSede.mockImplementation(async (_c: unknown, sede: string | null) => (sede ? `anno-di-${sede}` : null))
  h.scriviFrequenza.mockResolvedValue({ ok: true })
  h.riallineaImporto.mockResolvedValue(undefined)
})

describe('POST /api/admin/students — creazione', () => {
  const corpo = { nome: 'Prova', cognome: 'Finto', data_nascita: '2023-05-01', scuola_id: SEDE_A, usa_pannolino: true, giorno_scadenza_pagamenti: 10 }

  it('scrive la frequenza dell’anno attivo della sede, una volta, coi campi tradotti', async () => {
    const res = await CREA(crea(corpo))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: id,
      annoSedeId: `anno-di-${SEDE_A}`,
      campi: { usa_pannolino: true, giorno_scadenza_pagamenti: 10 },
    })
  })

  it('alunni in errore: 500 e zero chiamate', async () => {
    h.errori = { 'alunni:insert': { code: '23514', message: 'no' } }
    const res = await CREA(crea(corpo))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('scriviFrequenza fallita: la risposta resta 201', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SEZIONE_DI_ALTRO_ANNO' })
    expect((await CREA(crea(corpo))).status).toBe(201)
  })
})

describe('PATCH /api/admin/students — bulk', () => {
  it('gruppo mensa: una chiamata per alunno, con l’anno della sua sede', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_B], gruppo_mensa_id: null }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(2)
    const chiamate = h.scriviFrequenza.mock.calls.map((c) => c[1])
    expect(chiamate).toContainEqual({ alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_A}`, campi: { gruppo_mensa_id: null } })
    expect(chiamate).toContainEqual({ alunnoId: ALU_B, annoSedeId: `anno-di-${SEDE_B}`, campi: { gruppo_mensa_id: null } })
  })

  it('gruppo mensa: un id richiesto che l’UPDATE non ha toccato non riceve nessuna chiamata (si itera su `data`)', async () => {
    h.sparisceDopoLoScope = ALU_A2
    const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], gruppo_mensa_id: null }))
    expect(res.status).toBe(200)
    const chiamate = h.scriviFrequenza.mock.calls.map((c) => c[1].alunnoId)
    expect(chiamate).toEqual([ALU_A])
  })

  it('gruppo mensa con alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23503', message: 'no' } }
    const res = await PATCH(patch({ ids: [ALU_A], gruppo_mensa_id: null }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('classe_sezione: la patch non nomina colonne copiate, zero chiamate', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], classe_sezione: '2 ANNI' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/admin/students — singolo', () => {
  it('una colonna copiata: una chiamata con i campi tradotti', async () => {
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_A}`, campi: { usa_pannolino: true },
    })
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('patch senza colonne copiate (nome): zero chiamate', async () => {
    const res = await PATCH(patch({ id: ALU_A, nome: 'Altro' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('trasferimento: l’anno è quello della sede NUOVA, con sezione e gruppo mensa azzerati', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_A, annoSedeId: `anno-di-${SEDE_B}`, campi: { section_id: null, gruppo_mensa_id: null },
    })
  })

  it('scriviFrequenza fallita: la risposta resta 200', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((await PATCH(patch({ id: ALU_A, usa_pannolino: true }))).status).toBe(200)
  })
})

describe('POST /api/admin/students/archivia', () => {
  it('una chiamata: ritirato, uscita, sezione e gruppo mensa azzerati', async () => {
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2, motivo: 'ritiro' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    const arg = h.scriviFrequenza.mock.calls[0][1]
    expect(arg.alunnoId).toBe(ALU_A2)
    expect(arg.annoSedeId).toBe(`anno-di-${SEDE_A}`)
    expect(arg.campi).toMatchObject({ stato: 'ritirato', section_id: null, gruppo_mensa_id: null })
    expect(arg.campi.data_uscita).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/students/riattiva', () => {
  it('una chiamata: iscritto, senza uscita', async () => {
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(h.scriviFrequenza.mock.calls[0][1]).toEqual({
      alunnoId: ALU_R, annoSedeId: `anno-di-${SEDE_A}`, campi: { stato: 'iscritto', data_uscita: null },
    })
  })

  it('alunni in errore: zero chiamate', async () => {
    h.errori = { 'alunni:update': { code: '23514', message: 'no' } }
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  // Giro 1, B7: il bambino uscito col passaggio d'anno (frequenza dell'anno in corso chiusa PRIMA dell'archiviazione, o assente)
  // non si rimette `iscritto` da qui: la scheda resterebbe senza frequenza, con un 200 che dice il falso.
  it('senza nessuna frequenza nell’anno in corso: 409 ALUNNO_SENZA_ISCRIZIONE, la scheda non cambia', async () => {
    h.db.frequenze = []
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_SENZA_ISCRIZIONE')
    expect(h.db.alunni.find((r) => r.id === ALU_R)!.stato).toBe('ritirato')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('frequenza chiusa PRIMA del giorno dell’archiviazione (è uscito col passaggio): 409 anche così', async () => {
    h.db.frequenze = [{ id: 'fr-r', alunno_id: ALU_R, anno_sede_id: `anno-di-${SEDE_A}`, stato: 'ritirato', data_uscita: '2026-07-15' }]
    const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_SENZA_ISCRIZIONE')
  })
})

describe('PATCH /api/admin/students — fase B (4.3.5): prima la frequenza, poi alunni', () => {
  const aggiornamentiAlunni = () => h.scritture.filter((x) => JSON.stringify(x).includes('alunni'))

  it('frequenza scritta: alunni viene scritta DOPO, e la risposta è 200', async () => {
    h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
    const ordine: string[] = []
    h.scriviFrequenza.mockImplementation(async () => {
      ordine.push(`frequenza:${aggiornamentiAlunni().length}`)
      return { ok: true }
    })
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(200)
    // al momento della scrittura della frequenza `alunni` non era ancora stata toccata
    expect(ordine).toEqual(['frequenza:0'])
    expect(aggiornamentiAlunni().length).toBeGreaterThan(0)
  })

  it('frequenza non scritta: 500 FREQUENZA_NON_SCRITTA e alunni NON toccata', async () => {
    h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('FREQUENZA_NON_SCRITTA')
    expect(aggiornamentiAlunni()).toEqual([])
  })

  it('codice dell’anno (ANNO_NON_COERENTE): 422 e alunni NON toccata', async () => {
    h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'ANNO_NON_COERENTE' })
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(422)
    expect(aggiornamentiAlunni()).toEqual([])
  })

  it('fase A (interruttore spento): la frequenza fallita non cambia la risposta', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    expect((await PATCH(patch({ id: ALU_A, usa_pannolino: true }))).status).toBe(200)
  })
})

describe('PATCH /api/admin/students — lotti in fase B (giro di correzione 1)', () => {
  const auditDi = () => h.logScrittura.mock.calls.map((c) => ((c as unknown[])[1] as { entitaId: string }).entitaId).sort()
  const frequenzaFallisceA = (...ids: string[]) =>
    h.scriviFrequenza.mockImplementation(async (_c: unknown, a: { alunnoId: string }) =>
      ids.includes(a.alunnoId) ? { ok: false, codice: 'SCRITTURA_FALLITA' } : { ok: true })

  for (const [nome, corpo] of [
    ['classe_sezione', { classe_sezione: '2 ANNI' }],
    ['gruppo mensa', { gruppo_mensa_id: null }],
  ] as const) {
    it(`${nome}: una riga con la frequenza fallita è contata in errori, ha audit solo chi è stato scritto, risposta 200`, async () => {
      h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
      h.db.anni_sede = [
        { id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1' },
        { id: `anno-di-${SEDE_B}`, scuola_id: SEDE_B, anno_id: 'y1' },
      ]
      for (const sez of h.db.sections) sez.anno_id = 'y1'
      frequenzaFallisceA(ALU_A2)
      const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], ...corpo }))
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.updated).toBe(1)
      expect(j.errori).toEqual([{ id: ALU_A2, codice: 'SCRITTURA_FALLITA' }])
      expect(auditDi()).toEqual([ALU_A])
    })

    it(`${nome}: nessuna riga passa => 500 FREQUENZA_NON_SCRITTA e nessun audit`, async () => {
      h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
      h.db.anni_sede = [{ id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1' }]
      for (const sez of h.db.sections) sez.anno_id = 'y1'
      frequenzaFallisceA(ALU_A, ALU_A2)
      const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], ...corpo }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('FREQUENZA_NON_SCRITTA')
      expect(auditDi()).toEqual([])
    })

    it(`${nome}: l'UPDATE di alunni fallisce su tutte le righe DOPO la frequenza => 500 SCRITTURA_INCOMPLETA, alunni com'era, log dedicato, nessun audit`, async () => {
      h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
      h.errori = { 'alunni:update': { code: '23503', message: 'no' } }
      const prima = JSON.stringify(h.db.alunni)
      const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], ...corpo }))
      expect(res.status).toBe(500)
      const j = await res.json()
      // la frequenza di entrambe È stata scritta: la risposta non può dire «la scheda è rimasta com'era»
      expect(j.codice).toBe('SCRITTURA_INCOMPLETA')
      expect(h.scriviFrequenza.mock.calls.map((c) => c[1].alunnoId).sort()).toEqual([ALU_A, ALU_A2].sort())
      // e `alunni` è davvero rimasta com'era (l'UPDATE è fallito)
      expect(JSON.stringify(h.db.alunni)).toBe(prima)
      expect(auditDi()).toEqual([])
      // un log dedicato per riga
      expect(h.logErrore.mock.calls.filter((c) => c[0]?.operazione === 'anno/fase-b:alunni-non-scritto')).toHaveLength(2)
    })

    it(`${nome}: la riga con la frequenza scritta e alunni fallita NON è «non scritta»: codice di riga SCRITTURA_INCOMPLETA`, async () => {
      h.db.anno_regole = [{ specchio_frequenze_attivo: true }]
      h.scriviFrequenza.mockImplementation(async (_c: unknown, a: { alunnoId: string }) => {
        h.errori = a.alunnoId === ALU_A2 ? { 'alunni:update': { code: '23505', message: 'no' } } : {}
        return { ok: true }
      })
      const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], ...corpo }))
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.updated).toBe(1)
      expect(j.errori).toEqual([{ id: ALU_A2, codice: 'SCRITTURA_INCOMPLETA' }])
      expect(auditDi()).toEqual([ALU_A])
    })
  }
})

describe('POST /api/admin/students — data d’ingresso e anno attivo (giro di correzione 1)', () => {
  const corpo = (data: string) => ({ nome: 'Prova', cognome: 'Finto', data_nascita: '2023-05-01', scuola_id: SEDE_A, data_iscrizione: data })
  const conAnno = () => {
    h.db.anni_sede = [{ id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' }]
  }
  const campiScritti = () => h.scriviFrequenza.mock.calls.map((c) => c[1].campi)

  it('dentro l’anno attivo: data_ingresso = la data scelta', async () => {
    conAnno()
    const res = await CREA(crea(corpo('2026-10-15')))
    expect(res.status).toBe(201)
    expect(campiScritti()[0]).toMatchObject({ data_ingresso: '2026-10-15' })
  })

  it('PRIMA dell’inizio: accettata, alunni.data_iscrizione resta quella scritta, data_ingresso = inizio dell’anno', async () => {
    conAnno()
    const res = await CREA(crea(corpo('2025-03-10')))
    expect(res.status).toBe(201)
    expect(campiScritti()[0]).toMatchObject({ data_ingresso: '2026-09-01' })
    expect(JSON.stringify(h.scritture)).toContain('2025-03-10')
  })

  it('DOPO la fine: 422 ANNO_NON_COERENTE e nessuna scheda creata', async () => {
    conAnno()
    const res = await CREA(crea(corpo('2027-09-02')))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_COERENTE')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
    expect(JSON.stringify(h.scritture)).not.toContain('2027-09-02')
  })
})

describe('fase B: alunni fallisce DOPO la frequenza (archivia, riattiva, PATCH singolo)', () => {
  const faseB = () => { h.db.anno_regole = [{ specchio_frequenze_attivo: true }] }
  /** La frequenza «si scrive» e da quel momento ogni UPDATE di `alunni` fallisce con 23505. */
  const poiAlunniFallisce = () =>
    h.scriviFrequenza.mockImplementation(async () => {
      h.errori = { 'alunni:update': { code: '23505', message: 'duplicate key' } }
      return { ok: true }
    })
  const dedicati = () => h.logErrore.mock.calls.filter((c) => c[0]?.operazione === 'anno/fase-b:alunni-non-scritto')
  const riga = (id: string) => h.db.alunni.find((r) => r.id === id)!

  it('PATCH singolo (retta + CF già usato): 500 SCRITTURA_INCOMPLETA, non un errore grezzo, e il log dedicato parte', async () => {
    faseB()
    poiAlunniFallisce()
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SCRITTURA_INCOMPLETA')
    expect(j.error).toMatch(/frequenza/i)
    expect(j.error).not.toMatch(/duplicate key/)
    expect(h.scriviFrequenza).toHaveBeenCalledTimes(1)
    expect(dedicati()).toHaveLength(1)
    // l'audit di recupero c'è, ed è dei soli campi copiati in frequenza (qui: usa_pannolino), non della scheda intera
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = (h.logScrittura.mock.calls[0] as unknown[])[1] as { valoreDopo: Record<string, unknown> }
    expect(Object.keys(audit.valoreDopo)).toEqual(['usa_pannolino'])
  })

  it('PATCH singolo: alunni fallisce ma la frequenza non è stata toccata (anno non attivo): errore come prima, nessun log dedicato', async () => {
    faseB()
    h.scriviFrequenza.mockImplementation(async () => {
      h.errori = { 'alunni:update': { code: '23505', message: 'duplicate key' } }
      return { ok: true, saltata: 'anno-non-attivo' }
    })
    const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).not.toBe('SCRITTURA_INCOMPLETA')
    expect(dedicati()).toHaveLength(0)
  })

  it("archivia: la memoria è scritta PRIMA della frequenza; se alunni fallisce dopo, 500 SCRITTURA_INCOMPLETA e la memoria c'è", async () => {
    faseB()
    const ordine: string[] = []
    h.scriviFrequenza.mockImplementation(async () => {
      ordine.push(`frequenza:memoria=${String(riga(ALU_A2).archiviato_section_id)}`)
      h.errori = { 'alunni:update': { code: '23505', message: 'duplicate key' } }
      return { ok: true }
    })
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2, motivo: 'ritiro' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('SCRITTURA_INCOMPLETA')
    expect(j.error).not.toMatch(/rimasta com/)
    // quando la frequenza si scrive la memoria della classe c'è già
    expect(ordine).toEqual([`frequenza:memoria=${SEC_A}`])
    expect(riga(ALU_A2).archiviato_section_id).toBe(SEC_A)
    expect(riga(ALU_A2).archiviato_classe_sezione).toBe('2 ANNI')
    expect(dedicati()).toHaveLength(1)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('archivia: la memoria non riesce => 500 e la frequenza NON si scrive', async () => {
    faseB()
    h.errori = { 'alunni:update': { code: '23505', message: 'duplicate key' } }
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
    expect(res.status).toBe(500)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  describe("archivia: riprovare su un'archiviazione da completare", () => {
    /** Come la lascia il guasto: archiviato_il valorizzato (lo specchio), archiviato_da NULL, memoria piena. */
    const daCompletare = (extra: Record<string, unknown> = {}) => {
      Object.assign(riga(ALU_A2), {
        stato: 'ritirato', section_id: null, classe_sezione: null, gruppo_mensa_id: null,
        archiviato_il: '2026-08-01T10:00:00.000Z', archiviato_da: null, archiviato_motivo: null,
        archiviato_section_id: SEC_A, archiviato_classe_sezione: '2 ANNI', ...extra,
      })
    }

    it('non è un 409: completa autore e audit, e NON tocca la memoria', async () => {
      faseB()
      daCompletare()
      const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2, motivo: 'ritiro' }))
      expect(res.status).toBe(200)
      expect(riga(ALU_A2).archiviato_da).toBe('adm-1')
      expect(riga(ALU_A2).archiviato_section_id).toBe(SEC_A)
      expect(riga(ALU_A2).archiviato_classe_sezione).toBe('2 ANNI')
      // nessun UPDATE ha MAI portato la memoria nel payload (e quindi nessun NULL)
      for (const sc of (h.scritture as Scrittura[]).filter((x) => x.tabella === 'alunni')) {
        for (const v of sc.valori) {
          expect(Object.keys(v)).not.toContain('archiviato_section_id')
          expect(Object.keys(v)).not.toContain('archiviato_classe_sezione')
        }
      }
      // la data di archiviazione è quella originale, e l'uscita della frequenza la segue
      expect(riga(ALU_A2).archiviato_il).toBe('2026-08-01T10:00:00.000Z')
      expect(h.scriviFrequenza.mock.calls[0][1].campi.data_uscita).toBe('2026-08-01')
      expect(h.logScrittura).toHaveBeenCalledTimes(1)
    })

    it("anche se la memoria è vuota resta com'è: mai riscritta con dei NULL, né con valori inventati", async () => {
      faseB()
      daCompletare({ archiviato_section_id: null, archiviato_classe_sezione: null })
      const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
      expect(res.status).toBe(200)
      expect(riga(ALU_A2).archiviato_section_id).toBeNull()
      expect(riga(ALU_A2).archiviato_classe_sezione).toBeNull()
    })

    it('fase A (interruttore spento), stessa riga: completa lo stesso senza sovrascrivere la memoria', async () => {
      daCompletare()
      const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
      expect(res.status).toBe(200)
      expect(riga(ALU_A2).archiviato_section_id).toBe(SEC_A)
      expect(riga(ALU_A2).archiviato_classe_sezione).toBe('2 ANNI')
      expect(riga(ALU_A2).archiviato_da).toBe('adm-1')
    })

    it('archiviato per intero (archiviato_da valorizzato) resta un 409', async () => {
      faseB()
      daCompletare({ archiviato_da: 'adm-0' })
      const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('ALUNNO_GIA_ARCHIVIATO')
    })
  })

  describe('riattiva: dopo un fallimento a metà, riprovare completa il lavoro', () => {
    it("alunni fallisce dopo la frequenza: 500 SCRITTURA_INCOMPLETA, non «la scheda è rimasta com'era»", async () => {
      faseB()
      poiAlunniFallisce()
      const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
      expect(res.status).toBe(500)
      const j = await res.json()
      expect(j.codice).toBe('SCRITTURA_INCOMPLETA')
      expect(j.error).not.toMatch(/rimasta com/)
      expect(dedicati()).toHaveLength(1)
      expect(h.logScrittura).not.toHaveBeenCalled()
    })

    /** La riga come la lascia lo specchio dopo la frequenza `iscritto`: stato iscritto, archiviato_il NULL, tracce rimaste. */
    const mezzaRiattivata = () => {
      Object.assign(riga(ALU_R), { stato: 'iscritto', archiviato_il: null })
    }

    it("stato iscritto con le tracce dell'archiviazione ancora addosso: NON è un 409, completa e le azzera", async () => {
      faseB()
      mezzaRiattivata()
      const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
      expect(res.status).toBe(200)
      expect(riga(ALU_R)).toMatchObject({
        stato: 'iscritto', archiviato_da: null, archiviato_motivo: null,
        archiviato_section_id: null, archiviato_classe_sezione: null,
      })
      expect(h.logScrittura).toHaveBeenCalledTimes(1)
    })

    it('un alunno DAVVERO iscritto (nessuna traccia) resta un 409 ALUNNO_NON_ARCHIVIATO', async () => {
      faseB()
      Object.assign(riga(ALU_R), {
        stato: 'iscritto', archiviato_il: null, archiviato_da: null, archiviato_motivo: null,
        archiviato_section_id: null, archiviato_classe_sezione: null,
      })
      const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
      expect(res.status).toBe(409)
      expect((await res.json()).codice).toBe('ALUNNO_NON_ARCHIVIATO')
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
    })
  })
})

describe('PATCH singolo — la regola della data d’iscrizione vale anche qui (stesso helper del POST)', () => {
  const conAnno = () => {
    h.db.anni_sede = [{ id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' }]
  }
  const campiScritti = () => h.scriviFrequenza.mock.calls.map((c) => c[1].campi)
  const valoriAlunni = () => (h.scritture as Scrittura[]).filter((x) => x.tabella === 'alunni').flatMap((x) => x.valori)

  it('dentro l’anno attivo: data_ingresso = la data scelta', async () => {
    conAnno()
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-10-15' }))
    expect(res.status).toBe(200)
    expect(campiScritti()).toEqual([{ data_ingresso: '2026-10-15' }])
    expect(valoriAlunni()).toContainEqual(expect.objectContaining({ data_iscrizione: '2026-10-15' }))
  })

  it('PRIMA dell’inizio: alunni.data_iscrizione resta come scritta, data_ingresso = primo giorno dell’anno', async () => {
    conAnno()
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2025-03-10' }))
    expect(res.status).toBe(200)
    expect(campiScritti()).toEqual([{ data_ingresso: '2026-09-01' }])
    expect(valoriAlunni()).toContainEqual(expect.objectContaining({ data_iscrizione: '2025-03-10' }))
  })

  it('DOPO la fine: 422 ANNO_NON_COERENTE e nessuna scrittura', async () => {
    conAnno()
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2027-09-02' }))
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('ANNO_NON_COERENTE')
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
    expect(valoriAlunni()).toEqual([])
  })

  it('schema indietro (nessun anno attivo): solo alunni, mai la frequenza', async () => {
    h.annoAttivoDiSede.mockResolvedValue(null)
    const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2027-09-02' }))
    expect(res.status).toBe(200)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
    expect(valoriAlunni()).toContainEqual(expect.objectContaining({ data_iscrizione: '2027-09-02' }))
  })

  it('senza data_iscrizione nel corpo non si legge il periodo e non si scrive data_ingresso', async () => {
    conAnno()
    await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
    expect(campiScritti()).toEqual([{ usa_pannolino: true }])
  })
})


describe('PATCH singolo — il doppione del codice fiscale e la retta quando alunni fallisce dopo la frequenza', () => {
  const faseB = () => { h.db.anno_regole = [{ specchio_frequenze_attivo: true }] }
  const CF = 'RSSMRA80A01H501U'
  const dedicati = () => h.logErrore.mock.calls.filter((c) => c[0]?.operazione === 'anno/fase-b:alunni-non-scritto')
  const riga = (id: string) => h.db.alunni.find((r) => r.id === id)!
  const poiAlunniFallisce = () =>
    h.scriviFrequenza.mockImplementation(async () => {
      h.errori = { 'alunni:update': { code: '23505', message: 'duplicate key' } }
      return { ok: true }
    })

  describe('codice fiscale già di un altro alunno', () => {
    it('409 CODICE_FISCALE_GIA_USATO PRIMA di scrivere: nessuna frequenza, nessun alunni, nessun audit, e l’altro non è nominato', async () => {
      faseB()
      riga(ALU_A2).codice_fiscale = CF
      riga(ALU_A2).nome = 'NomeAltro'
      const res = await PATCH(patch({ id: ALU_A, codice_fiscale: CF, importo_retta_mensile: 300 }))
      expect(res.status).toBe(409)
      const j = await res.json()
      expect(j.codice).toBe('CODICE_FISCALE_GIA_USATO')
      expect(j.error).toMatch(/codice fiscale/i)
      const testo = JSON.stringify(j)
      expect(testo).not.toContain(ALU_A2)
      expect(testo).not.toContain('NomeAltro')
      expect(testo).not.toContain(CF)
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
      expect(h.scritture.filter((x) => (x as { tabella: string }).tabella === 'alunni')).toEqual([])
      expect(h.logScrittura).not.toHaveBeenCalled()
    })

    it('CONTROLLO POSITIVO — un codice fiscale libero passa, e lo stesso codice già suo non si controlla', async () => {
      faseB()
      expect((await PATCH(patch({ id: ALU_A, codice_fiscale: CF }))).status).toBe(200)
      // adesso è suo: salvare di nuovo la stessa scheda non è un doppione di sé stesso
      expect((await PATCH(patch({ id: ALU_A, codice_fiscale: CF, usa_pannolino: true }))).status).toBe(200)
    })
  })

  describe('frequenza scritta e alunni fallita: la retta scende lo stesso, una volta sola', () => {
    it('retta cambiata: discesa subito, e audit dei soli campi della frequenza con il VECCHIO importo; risposta 500 SCRITTURA_INCOMPLETA', async () => {
      faseB()
      riga(ALU_A).importo_retta_mensile = 100
      poiAlunniFallisce()
      const res = await PATCH(patch({ id: ALU_A, importo_retta_mensile: 300, note_mediche: 'riservato' }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SCRITTURA_INCOMPLETA')
      expect(dedicati()).toHaveLength(1)
      expect(h.riallineaImporto).toHaveBeenCalledTimes(1)
      expect(h.riallineaImporto.mock.calls[0].slice(1)).toEqual([ALU_A, 300])
      expect(h.logScrittura).toHaveBeenCalledTimes(1)
      const audit = (h.logScrittura.mock.calls[0] as unknown[])[1] as { entitaId: string; valorePrima: Record<string, unknown>; valoreDopo: Record<string, unknown> }
      expect(audit.entitaId).toBe(ALU_A)
      expect(audit.valorePrima).toEqual({ importo_retta_mensile: 100 })
      expect(audit.valoreDopo).toEqual({ importo_retta_mensile: 300 })
    })

    it('la RIPROVA riuscita non rifa la discesa (alunni ha già l’importo nuovo per lo specchio)', async () => {
      faseB()
      riga(ALU_A).importo_retta_mensile = 100
      poiAlunniFallisce()
      expect((await PATCH(patch({ id: ALU_A, importo_retta_mensile: 300 }))).status).toBe(500)
      // lo specchio ha già portato la retta nuova in alunni; il guasto è passato
      riga(ALU_A).importo_retta_mensile = 300
      h.errori = {}
      h.scriviFrequenza.mockResolvedValue({ ok: true })
      expect((await PATCH(patch({ id: ALU_A, importo_retta_mensile: 300 }))).status).toBe(200)
      expect(h.riallineaImporto).toHaveBeenCalledTimes(1)
    })

    it('retta NON cambiata: nessuna discesa e nessun audit di recupero', async () => {
      faseB()
      riga(ALU_A).importo_retta_mensile = 100
      poiAlunniFallisce()
      const res = await PATCH(patch({ id: ALU_A, usa_pannolino: true }))
      expect(res.status).toBe(500)
      expect(h.riallineaImporto).not.toHaveBeenCalled()
    })

    it('un guasto della discesa si logga e NON cambia la risposta', async () => {
      faseB()
      riga(ALU_A).importo_retta_mensile = 100
      poiAlunniFallisce()
      h.riallineaImporto.mockRejectedValue(new Error('boom'))
      const res = await PATCH(patch({ id: ALU_A, importo_retta_mensile: 300 }))
      expect(res.status).toBe(500)
      expect((await res.json()).codice).toBe('SCRITTURA_INCOMPLETA')
      expect(h.logErrore.mock.calls.some((c) => c[0]?.evento === 'recupero-retta-dopo-frequenza')).toBe(true)
    })
  })

  describe('data d’iscrizione: si scrive in frequenza solo se è cambiata', () => {
    it('PATCH che rimanda la STESSA data (la scheda salva il form intero) non forza la frequenza', async () => {
      h.db.anni_sede = [{ id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' }]
      riga(ALU_A).data_iscrizione = '2026-10-15'
      const res = await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-10-15', residence_address: 'Via Prova 1' }))
      expect(res.status).toBe(200)
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
    })

    it('una data DIVERSA la scrive', async () => {
      h.db.anni_sede = [{ id: `anno-di-${SEDE_A}`, scuola_id: SEDE_A, anno_id: 'y1', inizio: '2026-09-01', fine: '2027-08-31' }]
      riga(ALU_A).data_iscrizione = '2026-10-15'
      await PATCH(patch({ id: ALU_A, data_iscrizione: '2026-10-20' }))
      expect(h.scriviFrequenza.mock.calls[0][1].campi).toEqual({ data_ingresso: '2026-10-20' })
    })
  })
})

describe('archivia e riattiva — i ritocchi dopo la revisione', () => {
  const faseB = () => { h.db.anno_regole = [{ specchio_frequenze_attivo: true }] }
  const riga = (id: string) => h.db.alunni.find((r) => r.id === id)!
  const daCompletare = (extra: Record<string, unknown> = {}) =>
    Object.assign(riga(ALU_A2), {
      stato: 'ritirato', section_id: null, classe_sezione: null, gruppo_mensa_id: null,
      archiviato_il: '2026-08-01T10:00:00.000Z', archiviato_da: null, archiviato_motivo: null,
      archiviato_section_id: SEC_A, archiviato_classe_sezione: '2 ANNI', ...extra,
    })

  it('archivia da completare: un motivo GIÀ presente non si perde, anche se la riprova non ne porta', async () => {
    faseB()
    daCompletare({ archiviato_motivo: 'ritiro-originale' })
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A2).archiviato_motivo).toBe('ritiro-originale')
  })

  it('archivia da completare: con motivo NULL il motivo della riprova si scrive', async () => {
    faseB()
    daCompletare()
    expect((await ARCHIVIA(archivia({ alunno_id: ALU_A2, motivo: 'trasferimento' }))).status).toBe(200)
    expect(riga(ALU_A2).archiviato_motivo).toBe('trasferimento')
  })

  it('archivia: una scheda ANONIMIZZATA dà 409 e non riceve scritture', async () => {
    faseB()
    daCompletare({ anonimizzato_il: '2026-09-01T00:00:00.000Z' })
    const res = await ARCHIVIA(archivia({ alunno_id: ALU_A2 }))
    expect(res.status).toBe(409)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
    expect(h.scritture.filter((x) => (x as { tabella: string }).tabella === 'alunni')).toEqual([])
  })

  describe('riattiva: un iscritto con la memoria rimasta', () => {
    const iscrittoConMemoria = (classe: string | null) =>
      Object.assign(riga(ALU_R), {
        stato: 'iscritto', archiviato_il: null, section_id: classe ? SEC_A : null, classe_sezione: classe,
      })

    it('classe attuale UGUALE alla ricordata (archiviazione fallita a metà): completa senza spostare nessuno', async () => {
      faseB()
      iscrittoConMemoria('2 ANNI')
      const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
      expect(res.status).toBe(200)
      expect(riga(ALU_R).classe_sezione).toBe('2 ANNI')
    })

    it('classe attuale DIVERSA dalla ricordata (memoria stantia): 409, il bambino NON viene spostato', async () => {
      faseB()
      iscrittoConMemoria('3 ANNI')
      const res = await RIATTIVA(riattiva({ alunno_id: ALU_R }))
      expect(res.status).toBe(409)
      expect(riga(ALU_R).classe_sezione).toBe('3 ANNI')
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
    })
  })
})
