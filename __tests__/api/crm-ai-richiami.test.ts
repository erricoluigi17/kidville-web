import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/crm/ai/richiami/route'
import { ETICHETTA_PASSAGGIO, MOTIVI_PASSAGGIO, scegliResponsabile } from '@/lib/crm/ai/richiami'
import type { PersonaCrm } from '@/lib/crm/accesso'
import { contesto, contestoCrmAiAttivo } from '@/lib/logging/context'
import { campiCrmAi } from '@/lib/logging/crm-ai-privacy'
import {
  accendiAi, INTEGRAZIONE_A, INTEGRAZIONE_B, integrazioniFinte, nessunNomeIn, richiestaAi, TOKEN_A, TOKEN_B, TOKEN_REVOCATO,
} from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(args: Riga) => RispostaRpc>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    scritture: h.scritture,
    rpc: { crm_ai_richiamo: h.rpc },
  }),
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: h.logOk,
}))

const SCHEDA = '30000000-0000-4000-8000-00000000000a'
const SCHEDA_B = '30000000-0000-4000-8000-00000000000b'
const AZIONE = '60000000-0000-4000-8000-00000000000a'
const TELEFONO = '+39 000-700-0123'
const TELEFONO_NORM = '0007000123'
const NOME = 'Famiglia Sintetica'
const TESTO_PRIVATO = 'nota-sintetica-salute'
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']

const richiesta = (extra: Riga = {}, token?: string | null) =>
  richiestaAi('/api/crm/ai/richiami', {
    metodo: 'POST', token, corpo: { sede: SEDE_A, schedaId: SCHEDA, motivo: 'chiede_persona', ...extra },
  })
const chiama = (...args: Parameters<typeof richiesta>) => POST(richiesta(...args))
const esitoRpc = (data: unknown): RispostaRpc => ({ data, error: null })
const atteso = { azioneId: AZIONE, schedaId: SCHEDA, creata: true }

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  vi.clearAllMocks()
  h.lette = []
  h.scritture = []
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    crm_schede: [
      { id: SCHEDA, scuola_id: SEDE_A, telefoni_norm: [TELEFONO_NORM] },
      { id: SCHEDA_B, scuola_id: SEDE_B, telefoni_norm: [TELEFONO_NORM] },
    ],
    crm_azioni: [],
    crm_eventi: [],
  }
  // Il banco SQL prova le scritture. Qui il finto usa sede e identificatore ricevuti
  // per osservare l'inoltro alla sola RPC, anche con lo stesso numero in due sedi.
  h.rpc.mockReset().mockImplementation((args) => {
    const scheda = h.db.crm_schede.find((r) => r.scuola_id === args.p_scuola_id
      && (args.p_scheda_id === null
        ? (r.telefoni_norm as string[]).includes(args.p_telefono_norm as string)
        : r.id === args.p_scheda_id))
    return esitoRpc(scheda
      ? { esito: 'ok', azione_id: AZIONE, scheda_id: scheda.id, creata: true, nome: NOME }
      : { esito: 'non_trovata' })
  })
})
afterEach(() => vi.unstubAllEnvs())

function verificaSoloGate(integrazioneId = INTEGRAZIONE_A, sede = SEDE_A) {
  expect(h.lette).toEqual(LETTURE_GATE)
  expect(h.scritture).toMatchObject([
    { tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: integrazioneId, scuola_id: sede }] },
  ])
}

describe('scegliResponsabile', () => {
  const persone: PersonaCrm[] = [
    { id: 'gamma', nome: 'Alba', cognome: 'Gamma', ruolo: 'segreteria' },
    { id: 'beta-z', nome: 'Zeta', cognome: 'Beta', ruolo: 'segreteria' },
    { id: 'admin', nome: 'Alba', cognome: 'Alfa', ruolo: 'admin' },
    { id: 'beta-a', nome: 'Alba', cognome: 'Beta', ruolo: 'segreteria' },
  ]

  it('conserva la persona dell’ultima visita se appartiene ancora alla sede', () => {
    expect(scegliResponsabile(persone, 'gamma')).toBe('gamma')
    expect(scegliResponsabile(persone, 'admin')).toBe('admin')
  })

  it('sceglie la prima di segreteria per cognome e nome e conserva l’ordine dell’input', () => {
    expect(scegliResponsabile(persone, null)).toBe('beta-a')
    expect(scegliResponsabile(persone, 'altra-sede')).toBe('beta-a')
    expect(persone.map(({ id }) => id)).toEqual(['gamma', 'beta-z', 'admin', 'beta-a'])
  })

  it('ripiega sulla prima persona della Direzione o restituisce null', () => {
    const altri = [
      { id: 'z', nome: 'Alba', cognome: 'Zeta', ruolo: 'admin' },
      persone[2],
    ] satisfies PersonaCrm[]
    expect(scegliResponsabile(altri, null)).toBe('admin')
    expect(scegliResponsabile([], null)).toBeNull()
  })

  it('espone solo i nove motivi e le frasi fisse del passaggio', () => {
    const frasi = {
      chiede_persona: 'chiede di parlare con una persona',
      prezzo: 'insiste sul prezzo',
      sconto: 'chiede uno sconto',
      salute: 'messaggio sulla salute, da leggere in chat',
      reclamo: 'reclamo',
      non_so: 'domanda a cui l’assistente non sa rispondere',
      incomprensione: 'due scambi senza capirsi',
      vocale: 'vocale non chiaro',
      altro: 'altro',
    }
    expect(ETICHETTA_PASSAGGIO).toEqual(frasi)
    expect(MOTIVI_PASSAGGIO).toEqual(Object.keys(frasi))
  })
})

describe('POST /api/crm/ai/richiami', () => {
  it.each([
    [404, 'CRM_AI_SPENTO', TOKEN_A, []],
    [401, 'TOKEN_NON_VALIDO', null, []],
    [401, 'TOKEN_NON_VALIDO', TOKEN_REVOCATO, ['crm_integrazioni']],
  ] as const)('il gate risponde %s prima di leggere il corpo', async (stato, codice, token, lette) => {
    if (stato === 404) vi.stubEnv('CRM_AI_ATTIVO', '')
    const req = richiesta({ motivo: TESTO_PRIVATO }, token)
    const leggiCorpo = vi.spyOn(req, 'json')
    const r = await POST(req)
    expect(r.status).toBe(stato)
    expect(await r.json()).toMatchObject({ codice })
    if (stato === 401) expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(leggiCorpo).not.toHaveBeenCalled()
    expect(h.lette).toEqual(lette)
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rifiuta la sede dichiarata diversa da quella della chiave prima di chiamare la RPC', async () => {
    const r = await chiama({}, TOKEN_B)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    verificaSoloGate(INTEGRAZIONE_B, SEDE_B)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('inoltra id, sede, chiave e solo il codice motivo; espone i tre campi pubblici', async () => {
    const r = await chiama({ schedaId: SCHEDA.toUpperCase(), motivo: 'salute' })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual(atteso)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A,
      p_scuola_id: SEDE_A,
      p_scheda_id: SCHEDA,
      p_telefono: null,
      p_telefono_norm: null,
      p_genitore_nome: null,
      p_origine: null,
      p_motivo: 'salute',
    })
    verificaSoloGate()
  })

  it.each([
    [TELEFONO, undefined],
    ['0039 000/700.0123', NOME],
    ['(+39) 000 700 0123', NOME],
  ])('inoltra il telefono %s con l’origine e il nome facoltativo', async (telefono, genitoreNome) => {
    const r = await chiama({
      schedaId: undefined, telefono: ' ' + telefono + ' ', origine: 'whatsapp', genitoreNome, motivo: 'prezzo',
    })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual(atteso)
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A,
      p_scuola_id: SEDE_A,
      p_scheda_id: null,
      p_telefono: telefono,
      p_telefono_norm: TELEFONO_NORM,
      p_genitore_nome: genitoreNome ?? null,
      p_origine: 'whatsapp',
      p_motivo: 'prezzo',
    })
    verificaSoloGate()
    nessunNomeIn([h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls], [telefono, TELEFONO_NORM, NOME])
  })

  it('riusa il richiamo aperto indicato dalla RPC, senza altre scritture o un secondo log di creazione', async () => {
    h.rpc.mockReturnValueOnce(esitoRpc({ esito: 'ok', azione_id: AZIONE, scheda_id: SCHEDA, creata: false }))
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ...atteso, creata: false })
    verificaSoloGate()
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.logEvento).not.toHaveBeenCalledWith('crm', 'info', expect.objectContaining({ esito: 'ai-richiamo-in-lista' }))
  })

  it('restituisce 404 per la scheda di un’altra sede', async () => {
    const r = await chiama({ schedaId: SCHEDA_B })
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ codice: 'SCHEDA_NON_TROVATA' })
    expect(h.rpc).toHaveBeenCalledWith(expect.objectContaining({ p_scuola_id: SEDE_A, p_scheda_id: SCHEDA_B }))
    verificaSoloGate()
  })

  it.each([
    ['nessun_responsabile', 409, 'NESSUN_RESPONSABILE'],
    ['token_non_valido', 401, 'TOKEN_NON_VALIDO'],
  ])('traduce l’esito %s della RPC in un rifiuto fisso', async (esito, stato, codice) => {
    h.rpc.mockReturnValueOnce(esitoRpc({ esito, testo: TESTO_PRIVATO }))
    const r = await chiama()
    expect(r.status).toBe(stato)
    if (stato === 401) expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
    const corpo = await r.json()
    expect(corpo).toMatchObject({ codice })
    nessunNomeIn([corpo, h.logEvento.mock.calls, h.logErrore.mock.calls], [TESTO_PRIVATO])
    verificaSoloGate()
  })

  it.each([
    { schedaId: undefined },
    { telefono: TELEFONO, origine: 'whatsapp' },
    { schedaId: undefined, telefono: TELEFONO },
    { origine: 'whatsapp' },
    { genitoreNome: NOME },
    { sede: 'id-non-valido' },
    { motivo: TESTO_PRIVATO },
    { nota: TESTO_PRIVATO },
    { [TESTO_PRIVATO]: true },
    { schedaId: undefined, telefono: TELEFONO, origine: 'whatsapp', nota: TESTO_PRIVATO },
  ])('rifiuta un corpo fuori contratto senza interpellare la RPC (%j)', async (extra) => {
    const r = await chiama(extra)
    expect(r.status).toBe(400)
    verificaSoloGate()
    expect(h.rpc).not.toHaveBeenCalled()
    nessunNomeIn([await r.json(), h.logEvento.mock.calls, h.logErrore.mock.calls], [TESTO_PRIVATO, NOME, TELEFONO])
  })

  it.each(['non un numero', '+39' + TELEFONO_NORM + ' ' + TESTO_PRIVATO])('restituisce 422 per un recapito non valido (%s)', async (telefono) => {
    const r = await chiama({ schedaId: undefined, telefono, origine: 'whatsapp' })
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo).toMatchObject({ codice: 'CONTATTO_OBBLIGATORIO' })
    nessunNomeIn([corpo, h.logEvento.mock.calls, h.logErrore.mock.calls], [TESTO_PRIVATO, TELEFONO])
    verificaSoloGate()
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('registra il codice tecnico di un errore RPC senza dettagli', async () => {
    h.rpc.mockReturnValueOnce({
      data: null, error: { code: 'P0001', message: TESTO_PRIVATO, details: NOME, hint: TELEFONO },
    })
    const r = await chiama()
    expect(r.status).toBe(500)
    const corpo = await r.json()
    expect(corpo).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith({ operazione: 'crm/ai:richiamo', stato: 500 }, { code: 'P0001' })
    nessunNomeIn([corpo, h.logEvento.mock.calls, h.logErrore.mock.calls], [TESTO_PRIVATO, NOME, TELEFONO])
    verificaSoloGate()
  })

  it.each([
    { esito: 'ok', scheda_id: SCHEDA, creata: true },
    { esito: 'ok', scheda_id: SCHEDA_B, azione_id: AZIONE, creata: true },
    { esito: 'ok', scheda_id: SCHEDA, azione_id: AZIONE, creata: 'true' },
    { esito: TESTO_PRIVATO },
  ])('rifiuta un esito RPC incoerente o illeggibile (%j)', async (esito) => {
    h.rpc.mockReturnValueOnce(esitoRpc(esito))
    const r = await chiama()
    expect(r.status).toBe(500)
    const corpo = await r.json()
    expect(corpo).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    nessunNomeIn([corpo, h.logEvento.mock.calls, h.logErrore.mock.calls], [TESTO_PRIVATO])
    verificaSoloGate()
  })

  it('mantiene nel contesto protetto solo i metadati tecnici della creazione', async () => {
    h.rpc.mockImplementationOnce(() => {
      expect(contestoCrmAiAttivo()).toBe(true)
      expect(contesto()?.payload).toBeUndefined()
      return esitoRpc({ esito: 'ok', azione_id: AZIONE, scheda_id: SCHEDA, creata: true })
    })
    const r = await chiama({ schedaId: undefined, telefono: TELEFONO, origine: 'whatsapp', genitoreNome: NOME })
    expect(r.status).toBe(201)
    const successo = h.logEvento.mock.calls.find(([, , campi]) => campi.esito === 'ai-richiamo-in-lista')
    expect(successo).toBeDefined()
    const [, , campi] = successo!
    expect(campiCrmAi('crm', { ...campi, genitore_nome: NOME, nota: TESTO_PRIVATO })).toEqual({
      operazione: 'crm/ai:richiamo', esito: 'ai-richiamo-in-lista', scuola_id: SEDE_A, entita_id: SCHEDA,
    })
  })
})
