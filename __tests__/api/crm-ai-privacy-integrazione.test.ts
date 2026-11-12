import { inspect } from 'node:util'
import { NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import catalogoIt from '../../messages/it/shared.json'
import { accendiAi, integrazioniFinte, TOKEN_A, TOKEN_REVOCATO } from '../fixtures/crm-ai'
import { creaFintoSupabase, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { ContestoAi } from '@/lib/crm/ai/accesso'
import { improntaToken } from '@/lib/crm/ai/token'

const h = vi.hoisted(() => ({
  errori: {} as Record<string, ErrorePostgrest>,
  guasto: undefined as unknown,
  lette: [] as string[],
  scritture: [] as Scrittura[],
  rpc: vi.fn<(nome: string, argomenti: { righe: RigaLog[] }) => Promise<{ error: null }>>()
    .mockResolvedValue({ error: null }),
  creaLog: vi.fn(),
  creaAdmin: vi.fn(),
  limite: vi.fn(),
}))

type RigaLog = { request_id?: string; route?: string; contesto?: Record<string, unknown> }

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    h.creaAdmin()
    if (h.guasto !== undefined) throw h.guasto
    return creaFintoSupabase({ crm_integrazioni: integrazioniFinte() }, h.lette, {
      errori: h.errori,
      scritture: h.scritture,
    })
  },
  createLogClient: async () => {
    h.creaLog()
    return { rpc: h.rpc }
  },
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => {
    h.limite()
    return { ok: true, remaining: 59, retryAfterMs: 0 }
  },
}))

const NOME = 'NomeSinteticoPrivacy'
const TELEFONO = '00070000123'
const IMPRONTA = improntaToken(TOKEN_A)
const DETTAGLI = [NOME, TELEFONO, TOKEN_A, IMPRONTA].join(' ')
const CODICE_MALFORMATO = 'P0001:' + NOME
const ROTTA = 'crm/ai/slot:POST'
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

function richiesta({
  percorso = '/api/crm/ai/slot',
  token = TOKEN_A,
  intestazioni = { 'x-request-id': TOKEN_A, 'x-vercel-id': NOME },
}: { percorso?: string; token?: string | null; intestazioni?: Record<string, string> } = {}) {
  const headers = new Headers(intestazioni)
  if (token !== null) headers.set('authorization', 'Bearer ' + token)
  return new Request('http://test.invalid' + percorso + '?famiglia=' + NOME, { method: 'POST', headers })
}

let info: ReturnType<typeof vi.spyOn>
let errori: ReturnType<typeof vi.spyOn>
let rete: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  accendiAi([SEDE_A, SEDE_B])
  h.lette = []
  h.scritture = []
  h.errori = {}
  h.guasto = undefined
  vi.clearAllMocks()
  info = vi.spyOn(console, 'log').mockImplementation(() => {})
  errori = vi.spyOn(console, 'error').mockImplementation(() => {})
  rete = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rete non prevista dal test'))
})
afterEach(() => {
  const chiamateRete = rete.mock.calls.length
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  expect(chiamateRete).toBe(0)
})

async function carica() {
  const [{ withRoute }, gate, contesto] = await Promise.all([
    import('@/lib/logging/with-route'),
    import('@/lib/crm/ai/accesso'),
    import('@/lib/logging/context'),
  ])
  const conGate = (
    nome = ROTTA,
    dopoGate: (ai: ContestoAi, req: Request) => Response | Promise<Response> =
      (ai) => gate.chiudiChiamataAi(ai, NextResponse.json({ ok: true })),
  ) => withRoute(nome, async (req: Request) => {
    const esito = await gate.requireIntegrazioneAi(req, 'slot')
    if ('response' in esito) return esito.response
    return dopoGate(esito.ai, req)
  })
  return { withRoute, conGate, ...gate, ...contesto }
}

function righeRpc() {
  return h.rpc.mock.calls.flatMap(([nome, args]) => {
    expect(nome).toBe('app_log_registra')
    return args.righe
  })
}

function righeConsole() {
  return [info, errori].flatMap(spia => spia.mock.calls.flat().filter((v: unknown): v is string => typeof v === 'string'))
}

async function verificaRisposta(res: Response, stato: number, corpo: object) {
  expect(res.status).toBe(stato)
  const json: unknown = await res.json()
  expect(json).toEqual(corpo)
  const rid = res.headers.get('x-request-id')
  expect(rid).toMatch(UUID)
  expect(righeConsole().some(riga => riga.includes('rid=' + rid))).toBe(true)
  verificaNessunDato([json, [...res.headers]])
  return rid
}

function verificaNessunDato(extra?: unknown) {
  const emissioni = inspect([info.mock.calls, errori.mock.calls, righeRpc(), extra], { depth: null })
  expect([NOME, TELEFONO, TOKEN_A, TOKEN_REVOCATO, IMPRONTA].filter(v => emissioni.includes(v))).toEqual([])
}

const errore500 = {
  error: catalogoIt.erroreCrmOperazioneNonRiuscita,
  codice: 'CRM_OPERAZIONE_NON_RIUSCITA',
}

describe('Privacy della richiesta CRM AI, dal gate ai sink reali', () => {
  it('spento: correla il warn e il 404 senza aprire né il DB del CRM né quello del registro', async () => {
    vi.stubEnv('CRM_AI_ATTIVO', '')
    const { conGate } = await carica()
    const req = richiesta()
    const header = vi.spyOn(req.headers, 'get')
    const res = await conGate()(req)
    await verificaRisposta(res, 404, { error: catalogoIt.erroreCrmAiSpento, codice: 'CRM_AI_SPENTO' })
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_WARN'))
    expect(header).not.toHaveBeenCalledWith('authorization')
    expect(header).not.toHaveBeenCalledWith('x-request-id')
    expect(header).not.toHaveBeenCalledWith('x-vercel-id')
    expect(h.creaAdmin).not.toHaveBeenCalled()
    expect(h.creaLog).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([null, TOKEN_REVOCATO])('chiave assente o revocata (%s): mantiene il 401 e il solo warn del gate', async (token) => {
    const { conGate } = await carica()
    const res = await conGate()(richiesta({ token }))
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const rid = await verificaRisposta(res, 401, { error: catalogoIt.erroreCrmAiTokenNonValido, codice: 'TOKEN_NON_VALIDO' })
    expect(h.creaAdmin).toHaveBeenCalledTimes(token === null ? 0 : 1)
    expect(h.limite).not.toHaveBeenCalled()
    expect(h.scritture).toEqual([])
    expect(righeRpc()).toMatchObject([{ request_id: rid, livello: 'warn', codice: 'TOKEN_NON_VALIDO' }])
  })

  it.each([CODICE_MALFORMATO, 'PGRST205'])('lookup: il codice %s può uscire solo se tecnico', async (code) => {
    h.errori = { crm_integrazioni: { code, message: DETTAGLI, details: DETTAGLI, hint: DETTAGLI } }
    const { conGate } = await carica()
    const res = await conGate()(richiesta({ intestazioni: { 'x-vercel-id': TELEFONO } }))
    const valido = code === 'PGRST205'
    const rid = await verificaRisposta(res, valido ? 503 : 500, valido
      ? { error: 'Il CRM non è ancora disponibile su questo ambiente.', codice: 'CRM_NON_INSTALLATO' }
      : errore500)
    const righe = righeRpc()
    expect(righe.filter(riga => riga.request_id === rid)).toHaveLength(valido ? 2 : 1)
    expect(righe).toContainEqual(expect.objectContaining(valido
      ? { request_id: rid, livello: 'warn', codice: 'PGRST205' }
      : { request_id: rid, livello: 'error', stato_http: 500 }))
  })

  it.each([CODICE_MALFORMATO, 'XX000'])('ultimo uso: il codice %s non cambia il successo e il guasto resta visibile', async (code) => {
    h.errori = { 'crm_integrazioni:update': { code, message: DETTAGLI, details: DETTAGLI, hint: DETTAGLI } }
    const { conGate } = await carica()
    const res = await conGate()(richiesta({ intestazioni: { 'x-request-id': NOME } }))
    const rid = await verificaRisposta(res, 200, { ok: true })
    expect(righeConsole()).toContainEqual(expect.stringContaining('esito=ai-ultimo-uso-non-scritto'))
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_OK rid=' + rid))
    expect(righeRpc()).toContainEqual(expect.objectContaining({
      request_id: rid, livello: 'error', ...(code === 'XX000' ? { codice: code } : {}),
    }))
  })

  it('dopo il gate conserva successo e rifiuto, con rid isolati anche in concorrenza', async () => {
    const { conGate, chiudiChiamataAi, rifiutoAi, contesto } = await carica()
    let sblocca!: () => void
    const dueEntrate = new Promise<void>(resolve => { sblocca = resolve })
    const prima: Array<string | undefined> = []
    const dopo: Array<string | undefined> = []
    const route = conGate(ROTTA, async (ai, req) => {
      prima.push(contesto()?.requestId)
      if (prima.length === 2) sblocca()
      await dueEntrate
      dopo.push(contesto()?.requestId)
      return req.headers.has('x-prova-conflitto')
        ? chiudiChiamataAi(ai, rifiutoAi('SLOT_OCCUPATO', 409), { codice: 'SLOT_OCCUPATO' })
        : chiudiChiamataAi(ai, NextResponse.json({ ok: true }))
    })
    const [successo, rifiuto] = await Promise.all([
      route(richiesta()),
      route(richiesta({ intestazioni: { 'x-request-id': TOKEN_A, 'x-prova-conflitto': '1' } })),
    ])
    const ridOk = await verificaRisposta(successo, 200, { ok: true })
    const ridNo = await verificaRisposta(rifiuto, 409, { error: catalogoIt.erroreCrmSlotOccupato, codice: 'SLOT_OCCUPATO' })
    expect(ridOk).not.toBe(ridNo)
    expect(prima).toEqual([ridOk, ridNo])
    expect(dopo).toEqual(prima)
    expect(h.scritture).toHaveLength(2)
    expect(righeRpc()).toContainEqual(expect.objectContaining({ request_id: ridNo, livello: 'warn', codice: 'SLOT_OCCUPATO' }))
  })

  it.each(['gate', 'handler', 'getter ostile'])('eccezione nel %s: log fisso e 500 di catalogo', async (origine) => {
    const grezzo = Object.assign(new Error(DETTAGLI, { cause: new Error(DETTAGLI) }), {
      code: origine === 'gate' ? CODICE_MALFORMATO : 'P0001',
      stack: 'at prova (' + DETTAGLI + ')',
    })
    if (origine === 'gate') h.guasto = grezzo
    const { conGate, impostaPayload, impostaUtente } = await carica()
    const res = await conGate(ROTTA, () => {
      impostaPayload('body', { [NOME]: TELEFONO })
      impostaUtente({ userId: NOME })
      if (origine === 'getter ostile') throw { get code() { throw grezzo } }
      throw grezzo
    })(richiesta())
    const rid = await verificaRisposta(res, 500, errore500)
    const righe = righeRpc()
    expect(righe).toMatchObject([{
      request_id: rid, livello: 'error', stato_http: 500,
      codice: origine === 'handler' ? 'P0001' : 'CRM_OPERAZIONE_NON_RIUSCITA',
      messaggio: 'Eccezione durante una richiesta CRM AI',
    }])
    expect(righe[0].contesto).not.toHaveProperty('payload')
    expect(righe[0].contesto).not.toHaveProperty('causa')
    expect(errori.mock.calls.some(([v]: unknown[]) => v instanceof Error && v !== grezzo)).toBe(true)
  })

  it('percorso AI: sotto un contesto non sicuro riparte prima del gate e lascia intatto quello esterno', async () => {
    const { conGate, conContesto, contesto, withRoute } = await carica()
    const interno = conGate('prova/dispatch:POST')
    const esternoAi = withRoute('prova/involucro:POST', (req: Request) => interno(req))
    const esterno = { requestId: NOME, path: '/api/altro', userId: TELEFONO, payload: { body: { impronta: IMPRONTA } } }
    const res = await conContesto(esterno, async () => {
      const prima = contesto()
      const risposta = await esternoAi(richiesta({ percorso: '/api/crm/ai/slot/' + NOME, token: null }))
      expect(contesto()).toBe(prima)
      expect(contesto()).toMatchObject(esterno)
      return risposta
    })
    const rid = await verificaRisposta(res, 401, { error: catalogoIt.erroreCrmAiTokenNonValido, codice: 'TOKEN_NON_VALIDO' })
    expect(righeRpc()).toMatchObject([{ request_id: rid, route: '/api/crm/ai' }])
    expect(righeConsole()).toContainEqual(expect.stringContaining('rid=' + rid + ' evt=route rt=prova/dispatch:POST'))
    expect(righeConsole()).toContainEqual(expect.stringContaining('rid=' + rid + ' evt=route rt=prova/involucro:POST'))
  })

  it.each(['rifiuto', 'eccezione', 'risposta ricostruita'])('la delega AI riconosciuta solo dal nome mantiene l’id fino alla risposta: %s', async (caso) => {
    if (caso === 'eccezione') h.guasto = new Error(DETTAGLI)
    const { conGate, withRoute } = await carica()
    const interno = conGate()
    const mediano = withRoute('prova/mediano:POST', async (req: Request) => {
      const res = await interno(req)
      if (caso !== 'risposta ricostruita') return res
      return new Response(res.body, { status: res.status })
    })
    const esterno = withRoute('prova/esterno:POST', (req: Request) =>
      req.headers.has('x-prova-delega') ? mediano(req) : new Response(null, { status: 204 }))
    const [delegata, ordinaria] = await Promise.all([
      esterno(richiesta({
        percorso: '/api/prova',
        token: caso === 'eccezione' ? TOKEN_A : null,
        intestazioni: { 'x-request-id': TOKEN_A, 'x-prova-delega': '1' },
      })),
      esterno(richiesta({ percorso: '/api/prova', intestazioni: { 'x-request-id': 'trace-ordinaria' } })),
    ])
    expect(ordinaria.status).toBe(204)
    expect(ordinaria.headers.get('x-request-id')).toBe('trace-ordinaria')
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_OK rid=trace-ordinaria'))
    const rifiuto = caso !== 'eccezione'
    const rid = await verificaRisposta(delegata, rifiuto ? 401 : 500, rifiuto
      ? { error: catalogoIt.erroreCrmAiTokenNonValido, codice: 'TOKEN_NON_VALIDO' }
      : errore500)
    expect(righeRpc()).toMatchObject([{ request_id: rid, livello: rifiuto ? 'warn' : 'error' }])
    if (rifiuto) {
      for (const nome of ['prova/mediano:POST', 'prova/esterno:POST']) {
        expect(righeConsole()).toContainEqual(expect.stringContaining('rid=' + rid + ' evt=route rt=' + nome))
      }
    }
  })

  it('una Request distinta conserva il proprio contesto anche se restituisce una risposta del wrapper AI', async () => {
    const { conGate, withRoute } = await carica()
    const interno = conGate()
    const reqAi = richiesta({ percorso: '/api/prova' })
    const esterno = withRoute<[Request]>('prova/distinta:POST', () => interno(reqAi))
    const reqEsterno = richiesta({ percorso: '/api/prova', intestazioni: { 'x-request-id': 'trace-distinta' } })
    const res = await esterno(reqEsterno)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBe('trace-distinta')
    expect(righeConsole()).toContainEqual(expect.stringMatching(/KV_OK rid=[\da-f-]+ .*rt=crm\/ai\/slot:POST/))
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_OK rid=trace-distinta'))
    verificaNessunDato([...res.headers])
  })

  it('la traduzione di ANNO_CHIUSO resta attiva anche se l’handler CRM AI lancia', async () => {
    const { conGate, segnalaErroreAnno } = await carica()
    const res = await conGate(ROTTA, () => {
      segnalaErroreAnno('P0001', 'ANNO_CHIUSO')
      throw new Error(DETTAGLI)
    })(richiesta({ percorso: '/api/prova' }))
    const rid = await verificaRisposta(res, 409, { error: catalogoIt.erroreAnnoChiuso, codice: 'ANNO_CHIUSO' })
    expect(righeRpc()).toMatchObject([
      { request_id: rid, livello: 'error' },
      { request_id: rid, livello: 'warn', codice: 'ANNO_CHIUSO' },
    ])
  })

  it('la risposta AI conserva l’id anche se gli header originali sono immutabili', async () => {
    const { conGate } = await carica()
    const originale = Response.redirect('https://test.invalid/destinazione', 307)
    const res = await conGate(ROTTA, () => originale)(richiesta())
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(originale.headers.get('location'))
    const rid = res.headers.get('x-request-id')
    expect(rid).toMatch(UUID)
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_OK rid=' + rid))
    verificaNessunDato([...res.headers])
  })

  it('una rotta non AI conserva l’id del chiamante, il livello e l’eccezione originale', async () => {
    const { withRoute } = await carica()
    const req = richiesta({ percorso: '/api/crm/aiuti', intestazioni: { 'x-request-id': 'trace-legittima' } })
    const res = await withRoute('crm/aiuti:POST', () => new Response(null, { status: 204 }))(req)
    expect(res.status).toBe(204)
    expect(res.headers.get('x-request-id')).toBe('trace-legittima')
    expect(righeConsole()).toContainEqual(expect.stringContaining('KV_OK rid=trace-legittima'))
    const guasto = new Error('Eccezione ordinaria di prova')
    await expect(withRoute('crm/aiuti:POST', () => { throw guasto })(req)).rejects.toBe(guasto)
    expect(righeRpc()).toMatchObject([{ request_id: 'trace-legittima', livello: 'error', messaggio: guasto.message }])
  })
})
