import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/crm/ai/prenota/route'
import type { NotificaEventoParams } from '@/lib/notifiche/triggers'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(args: Riga) => RispostaRpc | Promise<RispostaRpc>>(),
  notifica: vi.fn<(supabase: unknown, parametri: NotificaEventoParams) => Promise<void>>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    errori: h.errori,
    scritture: h.scritture,
    rpc: { crm_ai_prenota: h.rpc },
  }),
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }))
vi.mock('@/lib/notifiche/triggers', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/notifiche/triggers')>()),
  notificaEvento: h.notifica,
}))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: h.logOk,
}))

const U1 = '20000000-0000-4000-8000-000000000001'
const U2 = '20000000-0000-4000-8000-000000000002'
const U_B = '20000000-0000-4000-8000-00000000000b'
const VISITA = '40000000-0000-4000-8000-000000000001'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const INIZIO = '2026-11-17T08:00:00.000Z'
const FINE = '2026-11-17T08:45:00.000Z'
const FINE_BREVE = '2026-11-17T08:30:00.000Z'
const CHIAVE = 'conv-0001-slot-a'
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
const TEL_PREFISSO = '+39 333-0000001'
const NASCITA = '2022-09-15'
const NOME_BIMBO = 'Bimbo Sintetico'
const GENITORE = 'Famiglia Sintetica'
const NOTA = 'Nota privata sintetica'
const DATI_RISERVATI = [NOME_BIMBO, GENITORE, TEL, TEL_NORM, NASCITA, NOTA]
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T07:00:00.000Z'))
  accendiAi([SEDE_A, SEDE_B])
  vi.clearAllMocks()
  h.rpc.mockReset().mockImplementation(() => { throw new Error('RPC non preparata dal test') })
  h.notifica.mockReset().mockResolvedValue(undefined)
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    crm_ai_richieste: [],
    utenti: [
      { id: U2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: U_B, nome: 'Marta', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
    ],
    utenti_scuole: [],
    sections: [{ id: 'sez-1', scuola_id: SEDE_A, name: 'Coccinelle', school_type: 'infanzia' }],
    crm_schede: [],
    crm_bambini: [],
    crm_appuntamenti: [],
    crm_settimane: [],
    crm_fasce: [],
    crm_indisponibilita: [],
    crm_eventi: [],
    crm_azioni: [],
  }
  programma(null)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function programma(utenteId: string | null, fascia: Riga = {}, sede = SEDE_A) {
  const id = `s-${h.db.crm_settimane.length + 1}`
  h.db.crm_settimane.push({ id, scuola_id: sede, utente_id: utenteId, settimana: '2026-11-16' })
  h.db.crm_fasce.push({
    id: `${id}-f`, scuola_id: sede, settimana_id: id,
    giorno_settimana: 2, ora_inizio: '09:00:00', ora_fine: '10:30:00', durata_slot_min: 45, ...fascia,
  })
}

function occupa(...persone: string[]) {
  for (const persona of persone) {
    h.db.crm_appuntamenti.push({
      scuola_id: SEDE_A, scheda_id: SCHEDA, inizio: INIZIO, fine: FINE,
      durata_min: 45, assegnata_a: persona, stato: 'in_programma',
    })
  }
}

const creata = (extra: Riga = {}): Riga => ({
  esito: 'creata', appuntamento_id: VISITA, inizio: '2026-11-17T08:00:00+00:00', fine: '2026-11-17T08:45:00+00:00',
  scheda_id: SCHEDA, scheda_creata: true, assegnata_a: U1, ...extra,
})
const successo = { id: VISITA, inizio: INIZIO, fine: FINE, schedaId: SCHEDA, schedaCreata: true, ripetuta: false }
const esito = (data: Riga): RispostaRpc => ({ data, error: null })
const corpo = (extra: Riga = {}) => ({
  sede: SEDE_A, inizio: INIZIO, fine: FINE, genitoreNome: GENITORE, telefono: TEL, origine: 'whatsapp',
  bambini: [{ nome: NOME_BIMBO, dataNascita: NASCITA }], ...extra,
})
const richiesta = (extra: Riga = {}, { token, chiave = CHIAVE }: { token?: string | null; chiave?: string | null } = {}) =>
  richiestaAi('/api/crm/ai/prenota', { metodo: 'POST', corpo: corpo(extra), token, chiave: chiave ?? undefined })
const chiama = (...args: Parameters<typeof richiesta>) => POST(richiesta(...args))

function registra(impronta: unknown, risposta: Riga | null, extra: Riga = {}) {
  h.db.crm_ai_richieste.push({
    scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, chiave: CHIAVE, operazione: 'prenota',
    impronta, risposta, ...extra,
  })
}

describe('POST /api/crm/ai/prenota', () => {
  it.each([
    ['interruttore spento', 404, 'CRM_AI_SPENTO'],
    ['senza chiave', 401, 'TOKEN_NON_VALIDO'],
  ])('%s: non legge il corpo e non accede al database', async (caso, stato, codice) => {
    if (stato === 404) vi.stubEnv('CRM_AI_ATTIVO', '')
    const req = richiesta({ fine: null }, { token: caso === 'senza chiave' ? null : undefined })
    const leggi = vi.spyOn(req, 'json')
    const r = await POST(req)
    expect(r.status).toBe(stato)
    expect(await r.json()).toMatchObject({ codice })
    expect(leggi).not.toHaveBeenCalled()
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('R2 · la chiave B non legge il registro o l’agenda della sede A', async () => {
    const r = await chiama({}, { token: TOKEN_B })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.scritture).toMatchObject([
      { tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: INTEGRAZIONE_B, scuola_id: SEDE_B }] },
    ])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('fissa una visita tramite la RPC e avvisa solo la persona assegnata con giorno e ora', async () => {
    h.rpc.mockReturnValue(esito(creata({ assegnata_a: U2 })))
    const r = await chiama({ telefono: TEL_PREFISSO, email: ' Prova@Example.com ', routine: NOTA })
    expect(r.status).toBe(201)
    const risposta = await r.json()
    expect(risposta).toEqual(successo)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A, p_scuola_id: SEDE_A, p_chiave: CHIAVE,
      p_impronta: expect.stringMatching(/^[0-9a-f]{64}$/), p_inizio: INIZIO, p_durata_min: 45,
      p_candidati: [U1, U2], p_telefono: TEL_PREFISSO, p_telefono_norm: TEL_NORM,
      p_email: 'Prova@Example.com', p_email_norm: 'prova@example.com', p_genitore_nome: GENITORE,
      p_origine: 'whatsapp', p_bambini: [{ nome: NOME_BIMBO, data_nascita: NASCITA }],
      p_routine: NOTA, p_paura: null, p_desiderio: null,
    })
    expect(h.scritture).toMatchObject([{ tabella: 'crm_integrazioni', operazione: 'update' }])
    expect(h.notifica).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      tipo: 'crm_visita_assegnata', scuolaId: SEDE_A, utenteIds: [U2], entitaId: VISITA,
      corpo: 'martedì 17 novembre, ore 09:00',
    }))
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-visita-fissata', scuola_id: SEDE_A, entita_id: VISITA,
    }))
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls, h.notifica.mock.calls[0][1]], DATI_RISERVATI)
  })

  it('la visita resta confermata se il tentativo di avviso fallisce', async () => {
    h.rpc.mockReturnValueOnce(esito(creata()))
    h.notifica.mockRejectedValueOnce({ code: 'XX000' })
    const r = await chiama()
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual(successo)
    expect(h.notifica).toHaveBeenCalledTimes(1)
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'notifica-non-inviata', scuola_id: SEDE_A, entita_id: VISITA,
    }), { code: 'XX000' })
  })

  it('R5 · impronta uguale per recapiti equivalenti, offset equivalenti e optional assenti o nulli', async () => {
    h.rpc.mockReturnValue(esito(creata()))
    await chiama({ email: 'Prova@Example.com' })
    await chiama({
      sede: SEDE_A.toUpperCase(), inizio: '2026-11-17T09:00:00+01:00', fine: '2026-11-17T09:45:00.000000+01:00',
      telefono: TEL_PREFISSO, email: ' prova@example.com ', paura: null, routine: '',
    })
    await chiama({ email: 'Prova@Example.com', bambini: [{ nome: 'Altra Prova', dataNascita: NASCITA }] })
    const [a, b, c] = h.rpc.mock.calls.map(([argomenti]) => argomenti.p_impronta)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it('distingue due durate con lo stesso inizio e usa la coppia scelta', async () => {
    h.db.crm_fasce = []
    programma(U1)
    programma(U2, { durata_slot_min: 30 })
    h.rpc.mockReturnValueOnce(esito(creata()))
    h.rpc.mockReturnValueOnce(esito(creata({ fine: FINE_BREVE, assegnata_a: U2 })))
    expect((await chiama()).status).toBe(201)
    const breve = await chiama({ fine: FINE_BREVE }, { chiave: 'conv-0001-slot-b' })
    expect(await breve.json()).toEqual({ ...successo, fine: FINE_BREVE })
    expect(h.rpc).toHaveBeenNthCalledWith(1, expect.objectContaining({ p_inizio: INIZIO, p_durata_min: 45, p_candidati: [U1] }))
    expect(h.rpc).toHaveBeenNthCalledWith(2, expect.objectContaining({ p_inizio: INIZIO, p_durata_min: 30, p_candidati: [U2] }))
    expect(h.rpc.mock.calls[0][0].p_impronta).not.toBe(h.rpc.mock.calls[1][0].p_impronta)
  })

  it('se una persona è occupata, conserva la candidata libera', async () => {
    occupa(U1)
    h.rpc.mockReturnValue(esito(creata({ assegnata_a: U2 })))
    expect((await chiama()).status).toBe(201)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_candidati: [U2] }))
  })

  it.each(['agenda occupata', 'fascia rimossa', 'copertura cambiata', 'anticipo scaduto'])(
    'A1 · ripete la visita registrata prima di nuovi controlli (%s)',
    async (cambio) => {
      const prima = creata()
      h.rpc.mockReturnValueOnce(esito(prima))
      expect((await chiama()).status).toBe(201)
      registra(h.rpc.mock.calls[0][0].p_impronta, prima)
      if (cambio === 'agenda occupata') occupa(U1, U2)
      if (cambio === 'fascia rimossa') h.db.crm_fasce = []
      if (cambio === 'copertura cambiata') h.db.sections = []
      if (cambio === 'anticipo scaduto') vi.setSystemTime(new Date(INIZIO))
      h.lette = []
      const r = await chiama()
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ...successo, ripetuta: true })
      expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
      expect(h.rpc).toHaveBeenCalledTimes(1)
      expect(h.notifica).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['sections', 'crm_appuntamenti'])('rilegge il registro prima del rifiuto se la prima visita viene registrata durante la lettura di %s', async (tabella) => {
    const prima = creata()
    h.rpc.mockReturnValueOnce(esito(prima))
    expect((await chiama()).status).toBe(201)
    const impronta = h.rpc.mock.calls[0][0].p_impronta
    if (tabella === 'sections') h.db.sections = []
    else h.db.crm_fasce = []

    h.lette = []
    const push = h.lette.push.bind(h.lette)
    const spy = vi.spyOn(h.lette, 'push').mockImplementation((...tabelle) => {
      if (tabelle.includes(tabella)) registra(impronta, prima)
      return push(...tabelle)
    })
    const r = await chiama()
    spy.mockRestore()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.lette.filter((letta) => letta === 'crm_ai_richieste')).toHaveLength(2)
    expect(h.lette.indexOf(tabella)).toBeLessThan(h.lette.lastIndexOf('crm_ai_richieste'))
    if (tabella === 'sections') expect(h.lette).not.toContain('crm_appuntamenti')
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ esito: 'slot_occupato', scheda_id: SCHEDA }, 'SLOT_OCCUPATO'],
    [{ ...creata(), esito: 'gia_prenotato' }, 'GIA_PRENOTATO'],
  ])('ripete il 409 registrato %s senza agenda o notifica', async (dati, codice) => {
    h.rpc.mockReturnValueOnce(esito(dati))
    const primo = await chiama()
    expect(primo.status).toBe(409)
    const risposta = await primo.json()
    expect(risposta).toMatchObject({ codice })
    expect(Object.keys(risposta).sort()).toEqual(codice === 'SLOT_OCCUPATO'
      ? ['codice', 'error'] : ['codice', 'error', 'fine', 'id', 'inizio'])
    registra(h.rpc.mock.calls[0][0].p_impronta, dati)
    h.db.sections = []
    h.lette = []
    const secondo = await chiama()
    expect(secondo.status).toBe(409)
    expect(await secondo.json()).toEqual(risposta)
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('la stessa chiave con impronta diversa viene rifiutata prima di età e agenda', async () => {
    registra('f'.repeat(64), creata())
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CHIAVE_RIUSATA' })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([
    { integrazione_id: INTEGRAZIONE_B },
    { scuola_id: SEDE_B },
    { chiave: 'conv-0001-slot-b' },
  ])('il registro è filtrato su sede, integrazione e chiave (%j)', async (altraRiga) => {
    registra('f'.repeat(64), creata(), altraRiga)
    h.rpc.mockReturnValueOnce(esito(creata()))
    expect((await chiama()).status).toBe(201)
  })

  it('se il registro è ancora aperto, la RPC decide prima di età e agenda', async () => {
    h.rpc.mockReturnValueOnce(esito(creata()))
    await chiama()
    registra(h.rpc.mock.calls[0][0].p_impronta, null)
    h.db.sections = []
    h.lette = []
    h.rpc.mockReturnValueOnce(esito({ esito: 'in_corso' }))
    const r = await chiama()
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_ai_richieste'])
    expect(h.rpc).toHaveBeenNthCalledWith(2, expect.objectContaining({ p_candidati: [], p_durata_min: 0 }))
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })

  it('R5 · la RPC può riconoscere un replay anche con l’agenda già occupata', async () => {
    occupa(U1, U2)
    h.rpc.mockReturnValueOnce(esito(creata({ ripetuta: true })))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...successo, ripetuta: true })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_candidati: [U1, U2] }))
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('con tutte le persone occupate, affida alla RPC il conflitto per la coppia in fascia', async () => {
    occupa(U1, U2)
    h.rpc.mockReturnValueOnce(esito({ esito: 'slot_occupato', scheda_id: SCHEDA }))
    const r = await chiama()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'SLOT_OCCUPATO' })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_candidati: [U1, U2], p_durata_min: 45 }))
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it.each([
    ['slot_occupato', 409, 'SLOT_OCCUPATO'],
    ['chiave_riusata', 422, 'CHIAVE_RIUSATA'],
    ['fuori_disponibilita', 422, 'FUORI_DISPONIBILITA'],
    ['token_non_valido', 401, 'TOKEN_NON_VALIDO'],
  ])('traduce l’esito RPC %s e limita la risposta ai soli campi pubblici', async (risultato, stato, codice) => {
    h.rpc.mockReturnValueOnce(esito({ ...creata(), esito: risultato, genitore: GENITORE, telefono: TEL }))
    const r = await chiama()
    expect(r.status).toBe(stato)
    expect(await r.json()).toEqual({ error: expect.any(String), codice })
    if (stato === 401) expect(r.headers.get('www-authenticate')).toBe('Bearer')
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it.each([
    ['coppia non offerta', { fine: '2026-11-17T08:35:00.000Z' }],
    ['fuori dalla griglia', { inizio: '2026-11-17T08:10:00.000Z', fine: '2026-11-17T08:55:00.000Z' }],
    ['fuori dalla fascia', { inizio: '2026-11-17T14:00:00.000Z', fine: '2026-11-17T14:45:00.000Z' }],
  ])('R6 · %s: 422 FUORI_DISPONIBILITA', async (_caso, campi) => {
    const r = await chiama(campi)
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'FUORI_DISPONIBILITA' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('R6 · due ore esatte sono ammesse e un millisecondo di anticipo in meno viene rifiutato', async () => {
    h.rpc.mockReturnValueOnce(esito(creata()))
    vi.setSystemTime(new Date('2026-11-17T06:00:00.000Z'))
    expect((await chiama()).status).toBe(201)
    vi.setSystemTime(new Date('2026-11-17T06:00:00.001Z'))
    const r = await chiama()
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'FUORI_DISPONIBILITA' })
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('basta che la sede copra l’età di uno dei bambini, senza indicare la classe', async () => {
    const nonCoperto = { nome: NOME_BIMBO, dataNascita: '2016-05-10' }
    h.db.sections.push({ id: 'sez-2', scuola_id: SEDE_B, school_type: 'primaria' })
    const r = await chiama({ bambini: [nonCoperto] })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'ETA_NON_COPERTA' })
    expect(h.lette).not.toContain('crm_appuntamenti')
    expect(h.rpc).not.toHaveBeenCalled()

    h.rpc.mockReturnValueOnce(esito(creata()))
    const s = await chiama({ bambini: [nonCoperto, { nome: 'Secondo Prova', dataNascita: NASCITA }] })
    expect(s.status).toBe(201)
    expect(await s.json()).toEqual(successo)
  })

  it('telefono che non è un numero: 422 CONTATTO_OBBLIGATORIO prima del registro', async () => {
    const r = await chiama({ telefono: 'non lo so' })
    expect(r.status).toBe(422)
    expect(await r.json()).toMatchObject({ codice: 'CONTATTO_OBBLIGATORIO' })
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each<[string, Riga, string | null]>([
    ['senza Idempotency-Key', {}, null],
    ['chiave troppo corta', {}, 'abc'],
    ['chiave troppo lunga', {}, 'a'.repeat(129)],
    ['chiave con caratteri estranei', {}, 'conv#0001'],
    ['senza bambini', { bambini: [] }, CHIAVE],
    ['bambino senza nome', { bambini: [{ dataNascita: NASCITA }] }, CHIAVE],
    ['data di nascita impossibile', { bambini: [{ nome: NOME_BIMBO, dataNascita: '2022-02-30' }] }, CHIAVE],
    ['campo in più', { [GENITORE]: U1 }, CHIAVE],
    ['campo bambino in più', { bambini: [{ nome: NOME_BIMBO, dataNascita: NASCITA, [NOME_BIMBO]: NOTA }] }, CHIAVE],
    ['inizio senza fuso', { inizio: '2026-11-17T09:00' }, CHIAVE],
    ['inizio con fuso impossibile', { inizio: '2026-11-17T09:00:00+99:00' }, CHIAVE],
    ['inizio con frazione non rappresentabile', { inizio: '2026-11-17T08:00:00.000001Z' }, CHIAVE],
    ['fine mancante', { fine: undefined }, CHIAVE],
    ['fine senza fuso', { fine: '2026-11-17T09:45' }, CHIAVE],
    ['fine precedente', { fine: '2026-11-17T07:55:00.000Z' }, CHIAVE],
    ['fine uguale', { fine: INIZIO }, CHIAVE],
    ['origine inventata', { origine: 'tiktok' }, CHIAVE],
  ])('validazione: %s → 400 senza accesso al CRM', async (_caso, campi, chiave) => {
    const r = await chiama(campi, { chiave })
    expect(r.status).toBe(400)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: 'Dati non validi', details: expect.any(Array) })
    expect(risposta.details.length).toBeGreaterThan(0)
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], DATI_RISERVATI)
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['registro', 'PGRST205', 503, 'CRM_NON_INSTALLATO'],
    ['registro', 'XX000', 500, 'CRM_OPERAZIONE_NON_RIUSCITA'],
    ['rpc', 'PGRST202', 503, 'CRM_NON_INSTALLATO'],
    ['rpc', 'XX000', 500, 'CRM_OPERAZIONE_NON_RIUSCITA'],
  ])('un guasto in %s (%s) conserva solo il codice tecnico', async (dove, code, stato, codice) => {
    const error = { code, message: GENITORE, details: NOTA, hint: NOME_BIMBO }
    if (dove === 'registro') h.errori.crm_ai_richieste = error
    else h.rpc.mockReturnValueOnce({ data: null, error })
    const r = await chiama()
    expect(r.status).toBe(stato)
    const risposta = await r.json()
    expect(risposta).toEqual({ error: expect.any(String), codice })
    const errori = stato === 500 ? h.logErrore.mock.calls : h.logEvento.mock.calls
    expect(errori.some((argomenti) => argomenti.some((arg) => arg?.code === code))).toBe(true)
    nessunNomeIn([risposta, h.logErrore.mock.calls, h.logEvento.mock.calls], DATI_RISERVATI)
    if (dove === 'registro') expect(h.rpc).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('un esito inatteso della RPC viene registrato senza riportare dati grezzi', async () => {
    h.rpc.mockReturnValueOnce(esito({ esito: NOTA }))
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), new Error('Esito inatteso da crm_ai_prenota'))
    expect(h.notifica).not.toHaveBeenCalled()
  })
})
