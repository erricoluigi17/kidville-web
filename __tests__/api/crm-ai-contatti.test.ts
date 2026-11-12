import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as REGISTRA } from '@/app/api/crm/ai/contatti/route'
import { POST as STATO } from '@/app/api/crm/ai/contatti/stato/route'
import { GET as NUOVI } from '@/app/api/crm/ai/contatti/nuovi/route'
import { visitaDi } from '@/lib/crm/ai/contatti'
import type { AppuntamentoRow } from '@/lib/crm/tipi'
import { accendiAi, integrazioniFinte, nessunNomeIn, richiestaAi, TOKEN_B } from '../fixtures/crm-ai'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  proiezioni: [] as { tabella: string; colonne: string }[],
  rpc: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabase(h.db, h.lette, {
      errori: h.errori,
      scritture: h.scritture,
      rpc: { crm_ai_registra_contatto: h.rpc },
      maxRighe: 1000,
    })
    const from = client.from.bind(client)
    vi.spyOn(client, 'from').mockImplementation((tabella: string) => {
      const query = from(tabella)
      const select = query.select.bind(query)
      vi.spyOn(query, 'select').mockImplementation((colonne, opzioni) => {
        h.proiezioni.push({ tabella, colonne: colonne ?? '*' })
        return select(colonne, opzioni)
      })
      return query
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

const S1 = '30000000-0000-4000-8000-000000000001'
const S2 = '30000000-0000-4000-8000-000000000002'
const S_AI = '30000000-0000-4000-8000-000000000003'
const S_B = '30000000-0000-4000-8000-00000000000b'
const B1 = '60000000-0000-4000-8000-000000000001'
const B2 = '60000000-0000-4000-8000-000000000002'
const V1 = '40000000-0000-4000-8000-000000000001'
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
const NASCITA = '2022-09-15'
const NOME_BIMBO = 'Bimbo Sintetico'
const NOME_GENITORE = 'Famiglia Sintetica'
const NOTA = 'Nota fittizia riservata'
const EMAIL = 'contatto@example.invalid'
const ADESSO = new Date('2026-11-16T07:00:00.000Z')
const CREATA = '2026-11-15T10:00:00.000Z'
const CREATA_DOPO = '2026-11-15T11:00:00.000Z'
const INIZIO = '2026-11-18T08:00:00.000Z'
const DOPO = '2026-11-15T00:00:00.000Z'
const SCONOSCIUTA = { esiste: false, schedaId: null, creatoVia: null, visita: null, bambini: [] }

const scheda = (campi: Riga = {}): Riga => ({
  id: S1, scuola_id: SEDE_A, genitore_nome: NOME_GENITORE, telefono1: TEL, telefoni_norm: [TEL_NORM],
  email_norm: [EMAIL], origine: 'telefonata', creato_via: 'segreteria', creata_il: CREATA,
  anonimizzata_il: null, routine: NOTA, ...campi,
})
const bambino = (campi: Riga = {}): Riga => ({
  id: B1, scuola_id: SEDE_A, scheda_id: S1, nome: NOME_BIMBO, data_nascita: NASCITA, creata_il: CREATA, ...campi,
})
const visita = (campi: Riga = {}): Riga => ({
  id: V1, scuola_id: SEDE_A, scheda_id: S1, inizio: INIZIO,
  fine: '2026-11-18T08:45:00.000Z', stato: 'in_programma', nota: NOTA, ...campi,
})

const registra = (campi: Riga = {}, token?: string | null) =>
  REGISTRA(richiestaAi('/api/crm/ai/contatti', {
    metodo: 'POST', token, corpo: { sede: SEDE_A, telefono: TEL, origine: 'sito', ...campi },
  }))
const stato = (campi: Riga = {}, token?: string | null) =>
  STATO(richiestaAi('/api/crm/ai/contatti/stato', {
    metodo: 'POST', token, corpo: { sede: SEDE_A, telefono: TEL, ...campi },
  }))
const nuovi = (campi: Record<string, string> = {}, token?: string | null) =>
  NUOVI(richiestaAi('/api/crm/ai/contatti/nuovi?' + new URLSearchParams({ sede: SEDE_A, dopo: DOPO, ...campi }), { token }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  accendiAi([SEDE_A, SEDE_B])
  h.errori = {}
  h.lette = []
  h.scritture = []
  h.proiezioni = []
  h.rpc.mockReset()
  h.logErrore.mockClear()
  h.logEvento.mockClear()
  h.db = { crm_integrazioni: integrazioniFinte(), crm_schede: [], crm_bambini: [], crm_appuntamenti: [] }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('visitaDi', () => {
  const v = (id: string, inizio: string, fine: string, stato: AppuntamentoRow['stato']) => ({ id, inizio, fine, stato })

  it('preferisce la prima visita ancora in corso o futura, anche davanti a una svolta', () => {
    const corrente = v('a', '2026-11-16T06:30:00Z', '2026-11-16T07:15:00Z', 'in_programma')
    const futura = v('b', INIZIO, '2026-11-18T08:45:00.000Z', 'in_programma')
    const svolta = v('c', '2026-11-16T06:50:00Z', '2026-11-16T07:10:00Z', 'svolto')
    expect(visitaDi([futura, svolta, corrente], ADESSO)).toEqual({
      id: corrente.id, inizio: corrente.inizio, stato: corrente.stato,
    })
  })

  it('dà l’ultima visita passata e ignora le annullate', () => {
    const finita = v('a', '2026-11-16T06:30:00Z', ADESSO.toISOString(), 'in_programma')
    const assente = v('b', '2026-11-15T06:30:00Z', '2026-11-15T07:00:00Z', 'non_presentato')
    const annullata = v('c', INIZIO, '2026-11-18T08:45:00.000Z', 'annullato')
    expect(visitaDi([finita, annullata, assente], ADESSO)).toEqual({
      id: finita.id, inizio: finita.inizio, stato: finita.stato,
    })
    expect(visitaDi([annullata], ADESSO)).toBeNull()
  })
})

describe.each([
  { nome: 'E1', valida: (token?: string | null) => registra({}, token), invalida: (token?: string | null) => registra({ origine: null }, token) },
  { nome: 'E2', valida: (token?: string | null) => stato({}, token), invalida: (token?: string | null) => stato({ telefono: null }, token) },
  { nome: 'E3', valida: (token?: string | null) => nuovi({}, token), invalida: (token?: string | null) => nuovi({ dopo: 'senza-fuso' }, token) },
])('$nome · gate reale', ({ valida, invalida }) => {
  it('a interruttore spento rifiuta anche input invalido prima del DB', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const r = await invalida()
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ codice: 'CRM_AI_SPENTO' })
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('senza chiave rifiuta anche input invalido prima del DB', async () => {
    const r = await invalida(null)
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ codice: 'TOKEN_NON_VALIDO' })
    expect(h.lette).toEqual([])
    expect(h.scritture).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rifiuta la chiave della sede B prima di interrogare le schede della A', async () => {
    const r = await valida(TOKEN_B)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.scritture).toMatchObject([{ tabella: 'crm_integrazioni', colpite: [{ scuola_id: SEDE_B }] }])
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('E1 · registra contatto', () => {
  it('risponde 201 e passa alla RPC la sede, i recapiti originali e normalizzati e i bambini facoltativi', async () => {
    h.rpc.mockResolvedValue({ data: { scheda_id: S1, creata: true }, error: null })
    const r = await registra({
      sede: SEDE_A.toUpperCase(), telefono: '0039 333-0000001', email: ' Contatto@Example.Invalid ',
      bambini: [{ dataNascita: NASCITA }, { nome: NOME_BIMBO }, {}],
    })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ schedaId: S1, creata: true, visita: null })
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith({
      p_scuola_id: SEDE_A, p_telefono: '0039 333-0000001', p_telefono_norm: TEL_NORM,
      p_email: 'Contatto@Example.Invalid', p_email_norm: EMAIL, p_genitore_nome: null, p_origine: 'sito',
      p_bambini: [
        { nome: null, data_nascita: NASCITA },
        { nome: NOME_BIMBO, data_nascita: null },
        { nome: null, data_nascita: null },
      ],
    })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-contatto-creato', scuola_id: SEDE_A, entita_id: S1,
    }))
    nessunNomeIn(h.logEvento.mock.calls, [NOME_BIMBO, NASCITA, TEL_NORM, EMAIL])
  })

  it('risponde 200 con la visita della scheda già nota', async () => {
    h.rpc.mockResolvedValue({ data: { scheda_id: S1, creata: false }, error: null })
    h.db.crm_appuntamenti.push(visita())
    const r = await registra()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ schedaId: S1, creata: false, visita: { id: V1, inizio: INIZIO, stato: 'in_programma' } })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'info', expect.objectContaining({
      esito: 'ai-contatto-gia-presente', scuola_id: SEDE_A, entita_id: S1,
    }))
  })

  it.each(['sconosciuto', `${TEL} ${NOTA}`])('risponde 422 per recapito non valido (%s), senza chiamare la RPC', async (telefono) => {
    h.rpc.mockResolvedValue({ data: { scheda_id: S1, creata: true }, error: null })
    const r = await registra({ telefono })
    expect(r.status).toBe(422)
    const risposta = await r.json()
    expect(risposta).toMatchObject({ codice: 'CONTATTO_OBBLIGATORIO' })
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], [NOTA, TEL, TEL_NORM])
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.scritture.map(({ tabella }) => tabella)).toEqual(['crm_integrazioni'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([
    { origine: undefined }, { origine: 'non-prevista' }, { bambini: Array.from({ length: 7 }, () => ({})) },
    { bambini: [{ dataNascita: '2022-02-30' }] }, { [NOTA]: 'privato' }, { bambini: [{ [NOME_BIMBO]: NOTA }] },
  ])('respinge un corpo fuori schema e non ripete nomi o note nella risposta', async (campi) => {
    const r = await registra(campi)
    expect(r.status).toBe(400)
    nessunNomeIn(await r.json(), [NOTA, NOME_BIMBO, 'privato'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('una RPC mancante risponde 503 e manda al logger solo il codice tecnico', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: NOME_GENITORE, details: NASCITA, hint: TEL } })
    const r = await registra()
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ codice: 'CRM_NON_INSTALLATO' })
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'warn', expect.objectContaining({ esito: 'schema-crm-assente' }), { code: 'PGRST202' })
    nessunNomeIn(h.logEvento.mock.calls, [NOME_GENITORE, NASCITA, TEL])
  })

  it.each(['AMBIGUITA_CONTATTO', 'RECAPITI_TELEFONICI_COMPLETI'])('un guasto SQL controllato (%s) non espone il messaggio', async (esito) => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: esito + ' ' + TEL } })
    const r = await registra()
    expect(r.status).toBe(500)
    const risposta = await r.json()
    expect(risposta).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/ai/contatti' }), { code: 'P0001' })
    nessunNomeIn([risposta, h.logErrore.mock.calls, h.logEvento.mock.calls], [esito, TEL])
  })

  it('un esito RPC anomalo non espone il valore ricevuto come ID', async () => {
    h.rpc.mockResolvedValue({ data: { scheda_id: NOME_GENITORE, creata: true }, error: null })
    const r = await registra()
    expect(r.status).toBe(500)
    nessunNomeIn(await r.json(), [NOME_GENITORE])
    nessunNomeIn(h.logEvento.mock.calls, [NOME_GENITORE])
  })
})

describe('E2 · stato contatto', () => {
  it('non riconosce una scheda assente, anonimizzata o di un’altra sede', async () => {
    h.db.crm_schede.push(scheda({ id: S_B, scuola_id: SEDE_B }), scheda({ anonimizzata_il: CREATA }))
    const r = await stato()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(SCONOSCIUTA)
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni', 'crm_schede'])
  })

  it('riconosce il numero alternativo, sceglie la scheda più vecchia e dà soltanto id, visita e mesi di nascita', async () => {
    h.db.crm_schede.push(scheda({ id: S2, creata_il: CREATA_DOPO }), scheda())
    h.db.crm_bambini.push(bambino({ id: B2, data_nascita: null }), bambino())
    h.db.crm_appuntamenti.push(visita())
    const r = await stato({ telefono: '+39 333-0000001' })
    expect(r.status).toBe(200)
    const j = await r.json()
    nessunNomeIn(j, [NOME_BIMBO, NOME_GENITORE, NASCITA, TEL, TEL_NORM, NOTA, EMAIL])
    expect(j).toEqual({
      esiste: true, schedaId: S1, creatoVia: 'segreteria',
      visita: { id: V1, inizio: INIZIO, stato: 'in_programma' },
      bambini: [{ id: B1, nascita: '2022-09' }, { id: B2, nascita: null }],
    })
    expect(h.proiezioni.find(({ tabella }) => tabella === 'crm_bambini')?.colonne.split(/,\s*/)).toEqual([
      'id', 'scheda_id', 'data_nascita', 'creata_il',
    ])
    expect(h.scritture.map(({ tabella }) => tabella)).toEqual(['crm_integrazioni'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('ignora dettagli di un’altra sede anche se riferiti allo stesso id di scheda', async () => {
    h.db.crm_schede.push(scheda())
    h.db.crm_bambini.push(bambino({ scuola_id: SEDE_B }))
    h.db.crm_appuntamenti.push(visita({ scuola_id: SEDE_B }))
    expect(await (await stato()).json()).toEqual({
      esiste: true, schedaId: S1, creatoVia: 'segreteria', visita: null, bambini: [],
    })
  })

  it.each(['sconosciuto', `${TEL} ${NOTA}`])('rifiuta un recapito non valido (%s) senza leggere schede', async (telefono) => {
    h.db.crm_schede.push(scheda())
    const r = await stato({ telefono })
    expect(r.status).toBe(422)
    const risposta = await r.json()
    expect(risposta).toMatchObject({ codice: 'CONTATTO_OBBLIGATORIO' })
    nessunNomeIn([risposta, h.logEvento.mock.calls, h.logErrore.mock.calls], [NOTA, TEL, TEL_NORM])
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni'])
    expect(h.scritture.map(({ tabella }) => tabella)).toEqual(['crm_integrazioni'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rifiuta i campi aggiuntivi senza leggere schede', async () => {
    const rifiutata = await stato({ [NOME_BIMBO]: NOTA })
    expect(rifiutata.status).toBe(400)
    nessunNomeIn(await rifiutata.json(), [NOME_BIMBO, NOTA])
    expect(h.lette).not.toContain('crm_schede')
  })

  it('un errore nei dettagli restituisce solo il codice tecnico al logger e nessuna scheda parziale', async () => {
    h.db.crm_schede.push(scheda())
    h.errori.crm_bambini = { code: '42501', message: NOME_BIMBO, details: NASCITA, hint: NOTA }
    const r = await stato()
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(j).not.toHaveProperty('schedaId')
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/ai/contatti/stato' }), { code: '42501' })
    nessunNomeIn(j, [NOME_BIMBO, NASCITA, NOTA])
  })
})

describe('E3 · nuovi contatti', () => {
  it('seleziona dalla più vecchia le sole schede attive inserite dalla segreteria nella sede', async () => {
    h.db.crm_schede.push(
      scheda({ id: S2, telefono1: null, telefoni_norm: [], creata_il: CREATA_DOPO, origine: 'altro' }),
      scheda({ id: S_AI, creato_via: 'ai' }),
      scheda({ id: S_B, scuola_id: SEDE_B }),
      scheda({ id: '30000000-0000-4000-8000-00000000000c', anonimizzata_il: CREATA }),
      scheda({ telefoni_norm: [TEL_NORM, '3330000002'] }),
    )
    h.db.crm_bambini.push(bambino())
    h.db.crm_appuntamenti.push(visita())
    const r = await nuovi()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const j = await r.json()
    nessunNomeIn(j, [NOME_BIMBO, NOME_GENITORE, NASCITA, TEL, NOTA, EMAIL, '3330000002'])
    expect(j).toEqual({
      contatti: [
        { schedaId: S1, creataIl: CREATA, telefono: TEL_NORM, origine: 'telefonata', visita: { id: V1, inizio: INIZIO, stato: 'in_programma' }, bambini: [{ id: B1, nascita: '2022-09' }] },
        { schedaId: S2, creataIl: CREATA_DOPO, telefono: null, origine: 'altro', visita: null, bambini: [] },
      ],
      prossimoDopo: CREATA_DOPO,
      prossimoDopoId: S2,
    })
    expect(h.scritture.map(({ tabella }) => tabella)).toEqual(['crm_integrazioni'])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la ricerca iniziale esclude l’istante di partenza e a pagina vuota non legge dettagli', async () => {
    h.db.crm_schede.push(scheda())
    expect(await (await nuovi({ dopo: CREATA })).json()).toEqual({
      contatti: [], prossimoDopo: null, prossimoDopoId: null,
    })
    expect(h.lette).toEqual(['crm_integrazioni', 'crm_integrazioni', 'crm_schede'])
  })

  it('riprende per ID oltre il limite a pari istante, conservando fuso e microsecondi', async () => {
    const pari = '2026-11-15T10:00:00.123456+01:00'
    const successivo = '2026-11-15T10:00:00.123457+01:00'
    const id = (n: number) => '30000000-0000-4000-8000-' + String(n).padStart(12, '0')
    const attesi = Array.from({ length: 105 }, (_, i) => id(i + 1))
    h.db.crm_schede.push(
      scheda({ id: id(0), creata_il: successivo }),
      ...attesi.toReversed().map((schedaId) => scheda({ id: schedaId, creata_il: pari })),
      scheda({ id: id(106), creata_il: pari, scuola_id: SEDE_B }),
      scheda({ id: id(107), creata_il: pari, anonimizzata_il: CREATA }),
    )

    const pagina1 = await (await nuovi({ dopo: '2026-11-15T10:00:00.123455+01:00' })).json()
    expect(pagina1.contatti.map((c: { schedaId: string }) => c.schedaId)).toEqual(attesi.slice(0, 100))
    expect(pagina1.prossimoDopo).toBe(pari)
    expect(pagina1.prossimoDopoId).toBe(id(100))

    const pagina2 = await (await nuovi({ dopo: pagina1.prossimoDopo, dopoId: pagina1.prossimoDopoId })).json()
    expect(pagina2.contatti.map((c: { schedaId: string }) => c.schedaId)).toEqual([...attesi.slice(100), id(0)])
    expect(pagina2.prossimoDopo).toBe(successivo)
    expect(pagina2.prossimoDopoId).toBe(id(0))
    expect(await (await nuovi({ dopo: pagina2.prossimoDopo, dopoId: pagina2.prossimoDopoId })).json()).toEqual({
      contatti: [], prossimoDopo: null, prossimoDopoId: null,
    })
  })

  it.each([
    { dopo: '2026-11-15T10:00' },
    { dopo: CREATA + ',id.not.is.null', dopoId: S1 },
    { dopoId: S1 + '),id.not.is.null' },
    { [NOTA]: 'privato' },
  ] as Record<string, string>[])('respinge query fuori schema prima della lettura delle schede', async (campi) => {
    const r = await nuovi(campi)
    expect(r.status).toBe(400)
    nessunNomeIn(await r.json(), [NOTA, 'id.not.is.null'])
    expect(h.lette).not.toContain('crm_schede')
  })

  it('un errore di lettura non riporta il testo grezzo del DB', async () => {
    h.errori.crm_schede = { code: '42501', message: NOME_GENITORE, details: TEL, hint: NOTA }
    const r = await nuovi()
    expect(r.status).toBe(500)
    expect(await r.json()).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'crm/ai/contatti/nuovi' }), { code: '42501' })
  })

  it.each([
    { tabella: 'crm_bambini', riga: bambino },
    { tabella: 'crm_appuntamenti', riga: visita },
  ])('un elenco troncato da PostgREST su $tabella non produce dettagli parziali', async ({ tabella, riga }) => {
    h.db.crm_schede.push(scheda())
    h.db[tabella] = Array.from({ length: 1001 }, (_, i) => riga({
      id: '70000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    }))
    const r = await nuovi()
    expect(r.status).toBe(500)
    const j = await r.json()
    expect(j).toMatchObject({ codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
    expect(j).not.toHaveProperty('contatti')
    expect(j).not.toHaveProperty('prossimoDopo')
    expect(h.logEvento).toHaveBeenCalledWith('crm', 'error', expect.objectContaining({
      esito: 'max-rows-raggiunto', scuola_id: SEDE_A, limite: 1000,
    }))
  })
})
