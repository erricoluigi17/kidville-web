import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'
import { personeDellaSede } from '@/lib/crm/accesso'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { GET } from '@/app/api/crm/ai/slot/route'
import { candidatiPer, caricaAgendaAi, orariPerAssistente } from '@/lib/crm/ai/disponibilita'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  guastoUtenti: null as { lettura: number; errore: ErrorePostgrest | Error } | null,
  annoAttivo: vi.fn<(args: Riga) => RispostaRpc>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabase(h.db, h.lette, {
      errori: h.errori, scritture: h.scritture, rpc: { anno_attivo: h.annoAttivo },
    })
    const from = client.from.bind(client)
    let lettureUtenti = 0
    vi.spyOn(client, 'from').mockImplementation((tabella: string) => {
      if (tabella === 'utenti' && ++lettureUtenti === h.guastoUtenti?.lettura) {
        const errore = h.guastoUtenti.errore
        if (errore instanceof Error) throw errore
        return creaFintoSupabase(h.db, h.lette, { errori: { utenti: errore } }).from(tabella)
      }
      return from(tabella)
    })
    return client
  },
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))

const U1 = '20000000-0000-4000-8000-000000000001'
const U2 = '20000000-0000-4000-8000-000000000002'
const U_B = '20000000-0000-4000-8000-00000000000b'
const ANNO = '70000000-0000-4000-8000-000000000001'
const ANNO_STORICO = '70000000-0000-4000-8000-000000000002'
const ANNO_FUTURO = '70000000-0000-4000-8000-000000000003'
const ANNO_SEDE_A = '80000000-0000-4000-8000-000000000001'
const ANNO_SEDE_B = '80000000-0000-4000-8000-000000000002'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T07:00:00.000Z'))
  accendiAi([SEDE_A, SEDE_B])
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.guastoUtenti = null
  h.annoAttivo.mockReset().mockImplementation(({ p_scuola }) => ({
    data: p_scuola === SEDE_A ? ANNO_SEDE_A : ANNO_SEDE_B, error: null,
  }))
  h.logErrore.mockClear()
  h.logEvento.mockClear()
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    utenti: [
      { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
    ],
    utenti_scuole: [],
    anni_sede: [
      { id: ANNO_SEDE_A, scuola_id: SEDE_A, anno_id: ANNO },
      { id: ANNO_SEDE_B, scuola_id: SEDE_B, anno_id: ANNO },
    ],
    sections: [{ id: 'sez-1', scuola_id: SEDE_A, anno_id: ANNO, name: 'Coccinelle', school_type: 'infanzia' }],
    crm_schede: [],
    crm_appuntamenti: [],
    crm_settimane: [],
    crm_fasce: [],
    crm_indisponibilita: [],
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function programma(utenteId: string | null, fasce: Riga[], settimana = '2026-11-16', sede = SEDE_A) {
  const id = `s-${h.db.crm_settimane.length + 1}`
  h.db.crm_settimane.push({ id, scuola_id: sede, utente_id: utenteId, settimana })
  fasce.forEach((f, n) => {
    h.db.crm_fasce.push({
      id: `${id}-f${n}`, scuola_id: sede, settimana_id: id,
      giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '10:30:00', durata_slot_min: 45, ...f,
    })
  })
}

const visita = (chi: string, campi: Riga = {}) => ({
  scuola_id: SEDE_A, assegnata_a: chi, stato: 'in_programma', scheda_id: 'x',
  inizio: '2026-11-17T08:00:00.000Z', fine: '2026-11-17T08:45:00.000Z', ...campi,
})

const url = (o: Record<string, string> = {}) =>
  '/api/crm/ai/slot?' + new URLSearchParams({ sede: SEDE_A, dal: '2026-11-16', al: '2026-11-22', nascita: '2022-09', ...o }).toString()
const chiama = (o: Record<string, string> = {}, token?: string | null) => GET(richiestaAi(url(o), { token }))
const inizi = (slot: { inizio: string }[]) => slot.map((s) => s.inizio)

describe('GET /api/crm/ai/slot', () => {
  it('R9 · a interruttore spento rifiuta anche una query invalida prima di accedere al DB', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const r = await chiama({ nascita: '' })
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ codice: 'CRM_AI_SPENTO' })
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
  })

  it('senza chiave rifiuta anche una query invalida prima di accedere al DB', async () => {
    const r = await chiama({ nascita: '' }, null)
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ codice: 'TOKEN_NON_VALIDO' })
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
  })

  it('R2 · la chiave B non legge l’agenda della sede A e aggiorna solo il proprio ultimo uso', async () => {
    const r = await chiama({}, TOKEN_B)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.scritture).toMatchObject([{ tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: INTEGRAZIONE_B, scuola_id: SEDE_B }] }])
  })

  it('R8 · dà gli orari liberi della sede, senza persone, nomi o note', async () => {
    programma(null, [{}])
    h.db.crm_schede.push({ id: 'x', scuola_id: SEDE_A, genitore_nome: 'Famiglia Prova' })
    h.db.crm_appuntamenti.push(visita(U1, { stato: 'annullato', nota: 'Nota sintetica riservata' }))
    const r = await chiama()
    expect(r.status).toBe(200)
    const risposta = await r.json()
    expect(risposta).toEqual({
      sede: SEDE_A,
      gradi: ['infanzia'],
      etaCoperta: true,
      troncato: false,
      slot: [
        { inizio: '2026-11-17T08:00:00.000Z', fine: '2026-11-17T08:45:00.000Z' },
        { inizio: '2026-11-17T08:45:00.000Z', fine: '2026-11-17T09:30:00.000Z' },
      ],
    })
    nessunNomeIn(risposta, ['Prova', 'Anna', 'Elena', 'Coccinelle', 'riservata', U1, U2])
    expect(h.lette).not.toContain('crm_schede')
    expect(h.scritture).toMatchObject([{ tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: INTEGRAZIONE_A, scuola_id: SEDE_A }] }])
  })

  it('unisce le fasce della persona e della sede con lo stesso inizio e la stessa fine', async () => {
    programma(null, [{}])
    programma(U1, [{}])
    const r = await chiama()
    expect(r.status).toBe(200)
    expect((await r.json()).slot).toHaveLength(2)
  })

  it('la fascia della sede è libera finché almeno una persona è disponibile', async () => {
    programma(null, [{}])
    h.db.crm_appuntamenti.push(visita(U1))
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-17T08:45:00.000Z'])
    h.db.crm_appuntamenti.push(visita(U2))
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-17T08:45:00.000Z'])
  })

  it('filtra per sede anche visite e assenze di una persona assegnabile in entrambi i plessi', async () => {
    h.db.utenti[0].ruolo = 'admin'
    h.db.utenti_scuole.push({ utente_id: U1, scuola_id: SEDE_B })
    programma(U1, [{}])
    h.db.crm_appuntamenti.push(visita(U1, { scuola_id: SEDE_B }))
    h.db.crm_indisponibilita.push({ scuola_id: SEDE_B, utente_id: U1, dal: '2026-11-17T08:45:00.000Z', al: '2026-11-17T09:30:00.000Z' })
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-17T08:45:00.000Z'])
  })

  it('non offre orari con meno di due ore di anticipo e accetta due ore esatte', async () => {
    programma(null, [{ giorno_settimana: 1, ora_fine: '12:00:00' }])
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-16T09:30:00.000Z', '2026-11-16T10:15:00.000Z'])
    vi.setSystemTime(new Date('2026-11-16T07:30:00.000Z'))
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-16T09:30:00.000Z', '2026-11-16T10:15:00.000Z'])
    vi.setSystemTime(new Date('2026-11-16T07:30:00.001Z'))
    expect(inizi((await (await chiama()).json()).slot)).toEqual(['2026-11-16T10:15:00.000Z'])
  })

  it('mantiene gli orari civili di Roma a cavallo del cambio dell’ora', async () => {
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'))
    programma(null, [{ giorno_settimana: 6 }, { giorno_settimana: 7 }], '2026-10-19')
    const r = await chiama({ dal: '2026-10-24', al: '2026-10-25' })
    expect(r.status).toBe(200)
    expect(inizi((await r.json()).slot)).toEqual([
      '2026-10-24T07:00:00.000Z', '2026-10-24T07:45:00.000Z',
      '2026-10-25T08:00:00.000Z', '2026-10-25T08:45:00.000Z',
    ])
  })

  it('le due ore di anticipo sono minuti effettivi anche nel cambio dell’ora', async () => {
    vi.setSystemTime(new Date('2026-10-25T00:30:00.000Z'))
    programma(null, [{ giorno_settimana: 7, ora_inizio: '03:00:00', ora_fine: '04:00:00', durata_slot_min: 30 }], '2026-10-19')
    const r = await chiama({ dal: '2026-10-25', al: '2026-10-25' })
    expect(r.status).toBe(200)
    expect((await r.json()).slot).toEqual([{ inizio: '2026-10-25T02:30:00.000Z', fine: '2026-10-25T03:00:00.000Z' }])
  })

  it('non pubblica orari che sforano la fascia nel salto di primavera', async () => {
    vi.setSystemTime(new Date('2026-03-28T08:00:00.000Z'))
    programma(null, [
      { giorno_settimana: 7, ora_inizio: '01:30:00', ora_fine: '03:15:00', durata_slot_min: 60 },
      { giorno_settimana: 7, ora_inizio: '03:15:00', ora_fine: '04:15:00', durata_slot_min: 60 },
    ], '2026-03-23')
    const r = await chiama({ dal: '2026-03-29', al: '2026-03-29' })
    expect(r.status).toBe(200)
    expect((await r.json()).slot).toEqual([{ inizio: '2026-03-29T01:15:00.000Z', fine: '2026-03-29T02:15:00.000Z' }])
  })

  it('toglie tutti gli orari durante un’assenza della sede', async () => {
    programma(null, [{}])
    h.db.crm_indisponibilita.push({ scuola_id: SEDE_A, utente_id: null, dal: '2026-11-16T23:00:00.000Z', al: '2026-11-17T23:00:00.000Z' })
    expect((await (await chiama()).json()).slot).toEqual([])
  })

  it('ignora le fasce di un’altra sede e di chi è stato archiviato', async () => {
    programma(null, [{}], '2026-11-16', SEDE_B)
    programma(U2, [{}])
    h.db.utenti[1].archiviato_il = '2026-11-15T00:00:00.000Z'
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ etaCoperta: true, slot: [] })
  })

  it('una sezione compatibile di un’altra sede non basta e non viene consultata l’agenda', async () => {
    programma(null, [{}])
    h.db.sections.push({ id: 'sez-2', scuola_id: SEDE_B, anno_id: ANNO, school_type: 'primaria' })
    const r = await chiama({ nascita: '2016-05' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sede: SEDE_A, gradi: ['primaria'], etaCoperta: false, troncato: false, slot: [] })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni', 'anni_sede', 'sections'])
  })

  it.each([
    ['storico', ANNO_STORICO],
    ['futuro', ANNO_FUTURO],
  ])('ignora le sezioni compatibili della sede quando sono solo nell’anno %s', async (_caso, annoId) => {
    programma(null, [{}])
    h.db.sections[0].anno_id = annoId
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ etaCoperta: false, slot: [] })
    expect(h.annoAttivo).toHaveBeenCalledExactlyOnceWith({ p_scuola: SEDE_A })
    expect(h.lette).not.toContain('crm_appuntamenti')

    h.db.sections[0].anno_id = ANNO
    const conAnnoAttivo = await chiama()
    expect(conAnnoAttivo.status).toBe(200)
    expect(await conAnnoAttivo.json()).toMatchObject({ etaCoperta: true, slot: [expect.anything(), expect.anything()] })
  })

  it.each([
    ['assente', null],
    ['di un’altra sede', ANNO_SEDE_B],
  ])('un anno attivo %s dà errore tecnico senza leggere sezioni o agenda', async (_caso, annoSedeId) => {
    h.annoAttivo.mockReturnValue({ data: annoSedeId, error: null })
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.lette).not.toContain('sections')
    expect(h.lette).not.toContain('crm_appuntamenti')
  })

  it('se il selettore dell’anno attivo non è installato risponde 503 e registra il solo codice tecnico', async () => {
    const sentinella = 'Dato privato sintetico'
    h.annoAttivo.mockReturnValue({ data: null, error: { code: 'PGRST202', message: sentinella } })
    const r = await chiama()
    expect(r.status).toBe(503)
    const risposta = await r.json()
    expect(risposta).toMatchObject({ codice: 'CRM_NON_INSTALLATO' })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'warn', expect.objectContaining({ esito: 'schema-crm-assente' }), { code: 'PGRST202' })
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], [sentinella])
    expect(h.lette).not.toContain('sections')
  })

  it('con un mese di nascita futuro non legge sezioni né agenda', async () => {
    const r = await chiama({ nascita: '2026-12' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sede: SEDE_A, gradi: [], etaCoperta: false, troncato: false, slot: [] })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
  })

  it('basta che la sede copra uno degli ordini possibili', async () => {
    programma(null, [{}])
    const r = await chiama({ nascita: '2024-06' })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.gradi).toEqual(['nido', 'infanzia'])
    expect(j.etaCoperta).toBe(true)
    expect(j.slot).toHaveLength(2)
  })

  it('accetta al a 31 giorni da dal e restituisce i primi 60 orari già deduplicati', async () => {
    const fasce = [1, 2, 3, 4, 5, 6, 7].map((giorno_settimana) => ({
      giorno_settimana, ora_inizio: '11:00:00', ora_fine: '15:00:00', durata_slot_min: 60,
    }))
    programma(null, fasce)
    programma(U1, fasce)
    const r = await chiama({ al: '2026-12-17' })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.troncato).toBe(true)
    const primi = inizi(j.slot)
    expect(primi).toHaveLength(60)
    expect(primi[0]).toBe('2026-11-16T10:00:00.000Z')
    expect(primi[59]).toBe('2026-11-30T13:00:00.000Z')
    expect(primi).toEqual([...new Set(primi)].sort())
    const esatti = await (await chiama({ al: '2026-11-30' })).json()
    expect(esatti.slot).toEqual(j.slot)
    expect(esatti.troncato).toBe(false)
  })

  it.each([
    ['manca la nascita', { nascita: '' }],
    ['nascita col giorno', { nascita: '2022-09-15' }],
    ['al prima di dal', { al: '2026-11-15' }],
    ['più di 31 giorni', { al: '2026-12-18' }],
    ['sede non UUID', { sede: 'giugliano' }],
    ['data impossibile', { dal: '2026-11-31' }],
    ['fine non rappresentabile', { dal: '9999-12-30', al: '9999-12-31' }],
  ])('validazione: %s → 400 prima di ogni lettura dell’agenda', async (_nome, o) => {
    const r = await chiama(o as Record<string, string>)
    expect(r.status).toBe(400)
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
  })

  it('rifiuta un campo query sconosciuto senza rifletterne il nome o leggere l’agenda', async () => {
    const sentinella = 'MinoreSentinellaReview'
    const r = await chiama({ [sentinella]: '1' })
    expect(r.status).toBe(400)
    const risposta = await r.json()
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], [sentinella])
    expect(risposta).toEqual({
      error: 'Dati non validi', details: [{ path: '', message: 'Sono presenti campi non ammessi' }],
    })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.annoAttivo).not.toHaveBeenCalled()
  })

  it('senza le tabelle delle settimane risponde 503 CRM_NON_INSTALLATO', async () => {
    h.errori = { crm_settimane: { code: 'PGRST205', message: 'tabella riservata' } }
    const r = await chiama()
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ codice: 'CRM_NON_INSTALLATO' })
    expect(h.logEvento.mock.calls).toContainEqual([
      'crm', 'warn', { operazione: 'crm/ai/slot:disponibilita', esito: 'schema-crm-assente' }, { code: 'PGRST205' },
    ])
    nessunNomeIn(h.logEvento.mock.calls, ['tabella riservata'])
  })

  it.each(['sections', 'crm_appuntamenti', 'crm_fasce', 'crm_indisponibilita'])('in caso di errore su %s risponde 500 e registra solo il codice', async (tabella) => {
    programma(null, [{}])
    h.errori = { [tabella]: { code: 'XX000', message: 'Famiglia Prova', details: 'Testo privato', hint: 'Altro testo privato' } }
    const r = await chiama()
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore.mock.calls).toContainEqual([expect.objectContaining({ stato: 500 }), { code: 'XX000' }])
    nessunNomeIn([j, h.logErrore.mock.calls, h.logEvento.mock.calls], ['Famiglia Prova', 'privato'])
  })

  it.each([
    ['primari', 1],
    ['utenti dal ponte', 2],
    ['rilettura finale', 3],
  ])('un guasto sugli utenti (%s) non lascia proporre un’agenda parziale', async (_fase, lettura) => {
    programma(null, [{}])
    h.db.utenti[2].ruolo = 'admin'
    h.db.utenti_scuole.push({ utente_id: U_B, scuola_id: SEDE_A })
    h.guastoUtenti = { lettura, errore: { code: 'XX000', message: 'Famiglia Prova', details: 'Testo privato', hint: 'Altro testo privato' } }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.logErrore.mock.calls).toContainEqual([expect.objectContaining({ stato: 500 }), { code: 'XX000' }])
    nessunNomeIn([await r.json(), h.logErrore.mock.calls, h.logEvento.mock.calls], ['Famiglia Prova', 'privato'])
  })

  it('un guasto del ponte non lascia proporre un’agenda parziale', async () => {
    programma(null, [{}])
    h.errori = { utenti_scuole: { code: 'XX000', message: 'Famiglia Prova' } }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.logErrore.mock.calls).toContainEqual([expect.objectContaining({ stato: 500 }), { code: 'XX000' }])
    nessunNomeIn([await r.json(), h.logErrore.mock.calls, h.logEvento.mock.calls], ['Famiglia Prova'])
  })

  it('un’eccezione inattesa sugli utenti dà 500 senza registrare il testo dell’eccezione', async () => {
    programma(null, [{}])
    h.guastoUtenti = { lettura: 1, errore: new Error('Famiglia Prova') }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.logErrore.mock.calls).toContainEqual([expect.objectContaining({ stato: 500 }), {}])
    expect(h.logEvento.mock.calls.some(([, , campi]) => campi?.esito === 'eccezione')).toBe(false)
    nessunNomeIn([await r.json(), h.logErrore.mock.calls, h.logEvento.mock.calls], ['Famiglia Prova'])
  })

  it('non registra un codice di errore dal formato non tecnico', async () => {
    h.errori = { sections: { code: 'Famiglia Prova' } }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalled()
    nessunNomeIn([await r.json(), h.logErrore.mock.calls, h.logEvento.mock.calls], ['Famiglia Prova'])
  })
})

describe('disponibilità AI per la prenotazione', () => {
  it('la modalità predefinita dell’agenda interna mantiene i primari se il ponte non è disponibile', async () => {
    const supabase = creaFintoSupabase(h.db, [], { errori: { utenti_scuole: { code: '42P01' } } })
    const persone = await personeDellaSede(supabase, SEDE_A)
    expect(persone.map((p) => p.id)).toEqual([U1, U2])
  })

  it('distingue una fascia esistente ma interamente occupata da un orario fuori fascia', async () => {
    programma(null, [{}])
    h.db.crm_appuntamenti.push(visita(U1), visita(U2))
    const agenda = await caricaAgendaAi(creaFintoSupabase(h.db), SEDE_A, '2026-11-17', '2026-11-17', new Date(), 'crm/ai/prenota')
    expect(agenda).not.toHaveProperty('response')
    if ('response' in agenda) throw new Error('Agenda non caricata')
    expect(inizi(agenda.inFascia)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-17T08:45:00.000Z'])
    expect(inizi(agenda.liberi)).toEqual(['2026-11-17T08:45:00.000Z'])
  })

  it('offre entrambe le durate e raccoglie i candidati della coppia scelta', async () => {
    programma(U1, [{}])
    programma(U2, [{ ora_fine: '09:30:00', durata_slot_min: 30 }])
    programma(null, [{}])
    const agenda = await caricaAgendaAi(creaFintoSupabase(h.db), SEDE_A, '2026-11-17', '2026-11-17', new Date(), 'crm/ai/prenota')
    if ('response' in agenda) throw new Error('Agenda non caricata')

    const inizio = '2026-11-17T08:00:00.000Z'
    const fineBreve = '2026-11-17T08:30:00.000Z'
    const fineLunga = '2026-11-17T08:45:00.000Z'
    expect(orariPerAssistente(agenda.liberi).filter((s) => s.inizio === inizio)).toEqual([
      { inizio, fine: fineBreve }, { inizio, fine: fineLunga },
    ])
    expect(candidatiPer(agenda.liberi, inizio, fineBreve)).toEqual({
      candidati: [U2], durataMin: 30, fine: fineBreve,
    })
    expect(candidatiPer(agenda.liberi, '2026-11-17T09:00:00+01:00', '2026-11-17T09:45:00+01:00')).toEqual({
      candidati: [U1, U2], durataMin: 45, fine: fineLunga,
    })
    expect(candidatiPer(agenda.liberi, inizio, '2026-11-17T08:35:00.000Z')).toBeNull()
    expect(candidatiPer(agenda.liberi, '2026-11-17T08:01:00.000Z', fineLunga)).toBeNull()
    expect(candidatiPer(agenda.liberi, inizio, 'fine non valida')).toBeNull()
  })

  it('preferisce le persone con una propria fascia anche se la fascia di sede è elencata per prima', () => {
    const inizio = '2026-11-17T08:00:00.000Z'
    const fine = '2026-11-17T08:45:00.000Z'
    expect(candidatiPer([
      { utenteId: null, inizio, fine, personeLibere: [U1, U2] },
      { utenteId: U2, inizio, fine },
    ], inizio, fine)).toEqual({ candidati: [U2, U1], durataMin: 45, fine })
  })
})


describe('codice tecnico del database', () => {
  it.each(['23505', '42P01', 'P0001', 'XX000', 'HV000', 'F0000', 'PGRST205'])('conserva solo il codice riconosciuto: %s', (code) => {
    const errore = Object.assign(new Error('Messaggio riservato'), {
      code, details: 'Dettagli riservati', hint: 'Suggerimento riservato', cause: 'Causa riservata',
    })
    expect(erroreDbSoloCodice(errore)).toEqual({ code })
  })

  it.each([undefined, null, 'XX000', { code: 23000 }, { code: 'ALICE' }, { code: 'PGRST205 extra' }, { code: 'PGRST205\n' }])(
    'non propaga un codice assente o non tecnico: %j',
    (errore) => {
      expect(erroreDbSoloCodice(errore)).toEqual({})
    },
  )
})
