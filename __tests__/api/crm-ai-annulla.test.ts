import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE } from '@/app/api/crm/ai/prenotazioni/[id]/route'
import { campiCrmAi } from '@/lib/logging/crm-ai-privacy'
import type { NotificaEventoParams } from '@/lib/notifiche/triggers'
import { TIPI_NOTIFICA } from '@/lib/notifiche/tipi'
import { INTEGRAZIONE_A, INTEGRAZIONE_B, TOKEN_B, accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type RispostaRpc, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(args: Riga) => RispostaRpc>(),
  notifica: vi.fn<(params: NotificaEventoParams) => Promise<void>>(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db, h.lette, {
    errori: h.errori,
    scritture: h.scritture,
    rpc: { crm_ai_annulla: h.rpc },
  }),
}))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (_db: unknown, params: NotificaEventoParams) => h.notifica(params),
}))
vi.mock('@/lib/logging/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: h.logOk,
}))

const VISITA = '40000000-0000-4000-8000-00000000000a'
const INESISTENTE = '40000000-0000-4000-8000-000000000404'
const SCHEDA = '30000000-0000-4000-8000-000000000001'
const U1 = '20000000-0000-4000-8000-000000000001'
const INIZIO = '2026-11-17T08:00:00.000Z'
const TESTO_PRIVATO = 'Nome sintetico da escludere'
const LETTURE_GATE = ['crm_integrazioni', 'crm_integrazioni']
const visita = (extra: Riga = {}): Riga => ({
  id: VISITA, scuola_id: SEDE_A, integrazione_id: INTEGRAZIONE_A, scheda_id: SCHEDA,
  inizio: INIZIO, assegnata_a: U1, fissato_via: 'ai', stato: 'in_programma', ...extra,
})

const richiesta = ({
  id = VISITA, query = '?sede=' + SEDE_A, token,
}: { id?: string; query?: string; token?: string | null } = {}) =>
  richiestaAi('/api/crm/ai/prenotazioni/' + id + query, { metodo: 'DELETE', token })
const chiama = (o?: Parameters<typeof richiesta>[0]) =>
  DELETE(richiesta(o), { params: Promise.resolve({ id: o?.id ?? VISITA }) })

const esito = (data: Riga): RispostaRpc => ({ data, error: null })

// Modella il contratto della RPC. Il test SQL di migrazione verifica transazione e blocchi sul database locale.
function annullaNelFinto(args: Riga): RispostaRpc {
  const tokenAttivo = h.db.crm_integrazioni.some((riga) => riga.id === args.p_integrazione_id
    && riga.scuola_id === args.p_scuola_id && riga.revocata_il === null)
  if (!tokenAttivo) return esito({ esito: 'token_non_valido' })
  const riga = h.db.crm_appuntamenti.find((v) => v.id === args.p_appuntamento_id
    && v.scuola_id === args.p_scuola_id && v.integrazione_id === args.p_integrazione_id && v.fissato_via === 'ai')
  if (!riga) return esito({ esito: 'non_trovato' })
  const risposta = { esito: 'annullata', appuntamento_id: riga.id }
  if (riga.stato === 'annullato') return esito({ ...risposta, gia_annullata: true })
  if (riga.stato !== 'in_programma') return esito({ esito: 'stato_non_ammesso' })
  riga.stato = 'annullato'
  h.db.crm_eventi.push({
    tipo: 'appuntamento_annullato', autore: null, autore_via: 'ai',
    scheda_id: riga.scheda_id, scuola_id: riga.scuola_id, dati: { appuntamento_id: riga.id },
  })
  return esito({ ...risposta, gia_annullata: false })
}

beforeEach(() => {
  accendiAi([SEDE_A, SEDE_B])
  vi.clearAllMocks()
  h.rpc.mockReset().mockImplementation(annullaNelFinto)
  h.notifica.mockReset().mockResolvedValue(undefined)
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.db = {
    crm_integrazioni: integrazioniFinte(),
    crm_appuntamenti: [visita()],
    crm_schede: [{ id: SCHEDA, scuola_id: SEDE_A, genitore_nome: TESTO_PRIVATO }],
    crm_eventi: [],
  }
})
afterEach(() => vi.unstubAllEnvs())

describe('DELETE /api/crm/ai/prenotazioni/[id]', () => {
  it.each([
    [404, 'CRM_AI_SPENTO'],
    [401, 'TOKEN_NON_VALIDO'],
  ])('il gate risponde %s prima di leggere parametri o database', async (status, codice) => {
    if (status === 404) vi.stubEnv('CRM_AI_ATTIVO', '')
    const leggiParametri = vi.fn(() => Promise.resolve({ id: TESTO_PRIVATO }))
    const r = await DELETE(richiesta({ query: '?sede=non-valida', token: status === 401 ? null : undefined }), {
      get params() { return leggiParametri() },
    })
    expect(r.status).toBe(status)
    expect(await r.json()).toMatchObject({ codice })
    if (status === 401) expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(leggiParametri).not.toHaveBeenCalled()
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('R2 · la chiave di un’altra sede si ferma al gate senza accedere alle visite', async () => {
    const r = await chiama({ token: TOKEN_B })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.scritture).toMatchObject([
      { tabella: 'crm_integrazioni', operazione: 'update', colpite: [{ id: INTEGRAZIONE_B, scuola_id: SEDE_B }] },
    ])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.db.crm_appuntamenti[0].stato).toBe('in_programma')
  })

  it.each([
    { id: TESTO_PRIVATO },
    { query: '' },
    { query: '?sede=non-valida' },
    { query: '?sede=' + SEDE_A + '&sede=' + SEDE_A },
    { query: '?sede=' + SEDE_A + '&' + encodeURIComponent(TESTO_PRIVATO) + '=1' },
  ])('rifiuta i parametri non validi prima della RPC (%j)', async (o) => {
    const r = await chiama(o)
    expect(r.status).toBe(400)
    expect(h.lette).toEqual(LETTURE_GATE)
    expect(h.rpc).not.toHaveBeenCalled()
    nessunNomeIn([await r.json(), h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls], [TESTO_PRIVATO])
  })

  it('delega alla RPC la transizione e lo storico, con id, sede e chiave verificati', async () => {
    const r = await chiama({ id: VISITA.toUpperCase() })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: false })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_integrazione_id: INTEGRAZIONE_A, p_scuola_id: SEDE_A, p_appuntamento_id: VISITA,
    })
    expect(h.db.crm_appuntamenti[0].stato).toBe('annullato')
    expect(h.db.crm_eventi).toEqual([{
      tipo: 'appuntamento_annullato', autore: null, autore_via: 'ai',
      scheda_id: SCHEDA, scuola_id: SEDE_A, dati: { appuntamento_id: VISITA },
    }])
    expect(h.scritture).toMatchObject([{ tabella: 'crm_integrazioni', operazione: 'update' }])
    expect(h.lette).toEqual([...LETTURE_GATE, 'crm_appuntamenti'])
    expect(TIPI_NOTIFICA.crm_visita_annullata).toMatchObject({ gruppo: 'staff' })
    expect(h.notifica).toHaveBeenCalledExactlyOnceWith({
      tipo: 'crm_visita_annullata', scuolaId: SEDE_A, utenteIds: [U1], destinatario: 'personale',
      titolo: 'Visita annullata', corpo: 'martedì 17 novembre, ore 09:00',
      link: '/admin/crm?tab=agenda', entitaTipo: 'crm_appuntamento', entitaId: VISITA, bufferMin: 0,
    })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-visita-annullata', scuola_id: SEDE_A, entita_id: VISITA,
    }))
    nessunNomeIn([h.notifica.mock.calls, h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls], [TESTO_PRIVATO])
  })

  it('ripete la cancellazione senza aggiungere un secondo evento', async () => {
    const [prima, seconda] = await Promise.all([chiama(), chiama()])
    expect([prima.status, seconda.status]).toEqual([200, 200])
    expect([await prima.json(), await seconda.json()]).toEqual(expect.arrayContaining([
      { id: VISITA, annullata: true, giaAnnullata: false },
      { id: VISITA, annullata: true, giaAnnullata: true },
    ]))
    expect(h.db.crm_eventi).toHaveLength(1)
    expect(h.lette.filter((tabella) => tabella === 'crm_appuntamenti')).toHaveLength(1)
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })

  it('restituisce lo stesso 404 per visita inesistente, di altra sede, di altra chiave o manuale', async () => {
    const assente = await chiama({ id: INESISTENTE })
    expect(assente.status).toBe(404)
    const corpo = await assente.json()
    expect(corpo).toEqual({ error: expect.any(String), codice: 'ELEMENTO_NON_TROVATO' })
    for (const extra of [
      { scuola_id: SEDE_B },
      { integrazione_id: '50000000-0000-4000-8000-00000000000c' },
      { fissato_via: 'segreteria' },
    ]) {
      h.db.crm_appuntamenti = [visita(extra)]
      const r = await chiama()
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual(corpo)
      expect(h.db.crm_appuntamenti[0].stato).toBe('in_programma')
    }
    expect(h.db.crm_eventi).toEqual([])
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.lette.every((tabella) => tabella === 'crm_integrazioni')).toBe(true)
  })

  it.each(['svolto', 'non_presentato'])('risponde 409 senza cambiare una visita in stato %s', async (stato) => {
    h.db.crm_appuntamenti = [visita({ stato })]
    const r = await chiama()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'STATO_NON_AMMESSO' })
    expect(h.db.crm_appuntamenti[0].stato).toBe(stato)
    expect(h.db.crm_eventi).toEqual([])
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('rispetta la revoca concorrente rilevata dalla RPC', async () => {
    h.rpc.mockReturnValueOnce(esito({ esito: 'token_non_valido' }))
    const r = await chiama()
    expect(r.status).toBe(401)
    expect(r.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(await r.json()).toEqual({ error: expect.any(String), codice: 'TOKEN_NON_VALIDO' })
    expect(h.db.crm_eventi).toEqual([])
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('gestisce l’errore della RPC con il solo codice tecnico nei log', async () => {
    h.rpc.mockReturnValueOnce({
      data: null, error: { code: 'XX000', message: TESTO_PRIVATO, details: TESTO_PRIVATO, hint: TESTO_PRIVATO },
    })
    const r = await chiama()
    expect(r.status).toBe(500)
    const json = await r.json()
    expect(json).toEqual({ error: expect.any(String), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.any(Object), { code: 'XX000' })
    nessunNomeIn([json, h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls], [TESTO_PRIVATO])
    expect(h.db.crm_appuntamenti[0].stato).toBe('in_programma')
    expect(h.db.crm_eventi).toEqual([])
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('non restituisce un esito di cancellazione incompleto dalla RPC', async () => {
    h.rpc.mockReturnValueOnce(esito({ esito: 'annullata', appuntamento_id: VISITA }))
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(await r.json()).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it.each([
    { id: INESISTENTE },
    { scuola_id: SEDE_B },
    { integrazione_id: '50000000-0000-4000-8000-00000000000c' },
    { fissato_via: 'segreteria' },
  ])('non invia l’avviso se la lettura successiva alla RPC trova solo una visita fuori ambito (%j)', async (extra) => {
    h.rpc.mockReturnValueOnce(esito({ esito: 'annullata', appuntamento_id: VISITA, gia_annullata: false }))
    h.db.crm_appuntamenti = [visita({ stato: 'annullato', ...extra })]
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: false })
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'notifica-non-inviata', entita_id: VISITA,
    }), {})
  })

  it('una lettura fallita dopo la RPC lascia confermata la cancellazione', async () => {
    h.errori['crm_appuntamenti:select'] = { code: 'XX000', message: TESTO_PRIVATO }
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: false })
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.rpc).toHaveBeenCalledTimes(1)
    expect(h.db.crm_eventi).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'notifica-non-inviata', entita_id: VISITA,
    }), { code: 'XX000' })
    nessunNomeIn(h.logEvento.mock.calls, [TESTO_PRIVATO])
  })

  it('un errore di notifica lascia la visita annullata e non accoda al replay', async () => {
    h.notifica.mockRejectedValueOnce({ code: 'XX000', message: TESTO_PRIVATO })
    const r = await chiama()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: false })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'notifica-non-inviata', entita_id: VISITA,
    }), { code: 'XX000' })
    expect(await (await chiama()).json()).toEqual({ id: VISITA, annullata: true, giaAnnullata: true })
    expect(h.notifica).toHaveBeenCalledTimes(1)
    expect(h.db.crm_eventi).toHaveLength(1)
    nessunNomeIn(h.logEvento.mock.calls, [TESTO_PRIVATO])
  })

  it('la proiezione protetta conserva i soli metadati tecnici dell’annullamento', () => {
    expect(campiCrmAi('crm', {
      operazione: 'crm/ai:annulla', esito: 'ai-visita-annullata',
      error_code: 'STATO_NON_AMMESSO', entita_id: VISITA, note: TESTO_PRIVATO,
    })).toEqual({
      operazione: 'crm/ai:annulla', esito: 'ai-visita-annullata', error_code: 'STATO_NON_AMMESSO', entita_id: VISITA,
    })
    expect(campiCrmAi('notifica', {
      operazione: 'notificaEvento', esito: 'notifica-non-accodata', tipo: 'crm_visita_annullata', note: TESTO_PRIVATO,
    })).toEqual({
      operazione: 'notificaEvento', esito: 'notifica-non-accodata', tipo: 'crm_visita_annullata',
    })
  })

  it.each([
    ['crm/ai/contatti', 'ai-contatto-creato'],
    ['crm/ai/contatti', 'ai-contatto-gia-presente'],
    ['crm/ai/contatti/stato', undefined],
    ['crm/ai/contatti/nuovi', undefined],
    ['crm_schede', undefined],
    ['crm_bambini', undefined],
  ])('conserva l’operazione tecnica dei contatti %s', (operazione, esito) => {
    expect(campiCrmAi('crm', { operazione, esito, note: TESTO_PRIVATO }))
      .toEqual(esito ? { operazione, esito } : { operazione })
  })
})
