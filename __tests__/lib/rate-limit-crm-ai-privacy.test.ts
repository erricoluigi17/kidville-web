import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RigaLog = {
  codice?: string
  contesto?: { campi?: Record<string, unknown> }
  evento: string
  fingerprint: string
  livello: string
  messaggio: string
  request_id?: string
}

const h = vi.hoisted(() => ({
  tetto: vi.fn<(nome: string, args: Record<string, unknown>) => Promise<unknown>>(),
  registro: vi.fn<(nome: string, args: { righe: RigaLog[] }) => Promise<{ error: null }>>()
    .mockResolvedValue({ error: null }),
  apri: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => { h.apri(); return { rpc: h.tetto } },
  createLogClient: async () => ({ rpc: h.registro }),
}))

const NOME = 'NomeSinteticoLimite'
const TELEFONO = '00070000231'
const TOKEN = 'kvai_' + 'K'.repeat(43)
const TESTO = [NOME, TELEFONO, TOKEN].join(' ')
const CHIAVE = 'crm-ai:50000000-0000-4000-8000-000000000001'
const CODICE_RIPIEGO = 'rate_limit_crm_ai'
const DIAGNOSI = 'Errore del limitatore CRM AI'
const opzioni = { limit: 1, windowMs: 60_000 }

let consoleError: ReturnType<typeof vi.spyOn>
let consoleLog: ReturnType<typeof vi.spyOn>
let rete: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  h.apri.mockReset()
  h.tetto.mockReset()
  h.registro.mockClear()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  rete = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Rete non prevista dal test'))
})
afterEach(() => {
  const chiamateRete = rete.mock.calls.length
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  expect(chiamateRete).toBe(0)
})

function righe() {
  return h.registro.mock.calls.flatMap(([nome, args]) => {
    expect(nome).toBe('app_log_registra')
    return args.righe
  })
}

function senzaDati() {
  const emissioni = inspect([consoleError.mock.calls, consoleLog.mock.calls, righe()], { depth: null })
  expect([NOME, TELEFONO, TOKEN, CHIAVE].filter(v => emissioni.includes(v))).toEqual([])
}

function guasto(code: string, message = TESTO) {
  return Object.assign(new Error(message, { cause: new Error(TESTO) }), {
    code, details: TESTO, hint: TESTO, stack: 'at prova (' + TESTO + ')',
  })
}

describe('Degrado del limitatore CRM AI, fino alla RPC di app_log', () => {
  it('scarta codice e testo grezzi del gruppo CRM AI; mantiene limite locale e deduplica', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const inizio = Date.now()
    h.tetto.mockResolvedValue({ error: guasto('P0001:' + NOME) })
    const { rateLimit } = await import('@/lib/security/rate-limit')
    expect(await rateLimit(CHIAVE, opzioni, 1000)).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 })
    expect(await rateLimit(CHIAVE, opzioni, 1001)).toEqual({ ok: false, remaining: 0, retryAfterMs: 59_999 })
    expect(h.tetto).toHaveBeenCalledTimes(2)
    expect(h.tetto).toHaveBeenCalledWith('tetto_frequenza_consuma', {
      p_chiave: CHIAVE, p_limite: 1, p_finestra_ms: 60_000,
    })
    await vi.waitFor(() => expect(righe()).toHaveLength(1))
    senzaDati()
    expect(righe()).toMatchObject([{
      livello: 'error', codice: CODICE_RIPIEGO, messaggio: DIAGNOSI,
      contesto: { campi: { azione: 'rpc_errore', esito: 'conteggio_locale', tipo: 'crm-ai' } },
    }])

    // Superato il silenzio di processo, due motivi distinti restano distinti in tabella.
    vi.setSystemTime(inizio + 61_000)
    h.tetto.mockResolvedValue({ data: [{ forma: 'inattesa' }] })
    await rateLimit(CHIAVE, opzioni, 62_000)
    await vi.waitFor(() => expect(righe()).toHaveLength(2))
    const [errore, malformata] = righe()
    expect(errore.fingerprint).not.toBe(malformata.fingerprint)
    expect(malformata.contesto?.campi?.azione).toBe('rpc_malformata')
  })

  it('riconosce il timeout originale prima di sostituirne il testo e conserva il livello warn', async () => {
    h.tetto.mockResolvedValue({ error: guasto('P0001', 'SupabaseTimeoutError: ' + TESTO) })
    const { rateLimit } = await import('@/lib/security/rate-limit')
    expect((await rateLimit(CHIAVE, opzioni)).ok).toBe(true)
    await vi.waitFor(() => expect(righe()).toHaveLength(1))
    senzaDati()
    expect(righe()).toMatchObject([{
      livello: 'warn', codice: 'P0001', messaggio: DIAGNOSI,
      contesto: { campi: { azione: 'rpc_scaduta' } },
    }])
  })

  it.each(['gruppo', 'contesto verificato'])('client assente: protegge la diagnosi per %s prima della RPC', async (via) => {
    h.apri.mockImplementation(() => { throw guasto('XX000') })
    const { rateLimit } = await import('@/lib/security/rate-limit')
    let rid: string | null | undefined
    if (via === 'gruppo') {
      expect((await rateLimit(CHIAVE, opzioni)).ok).toBe(true)
    } else {
      const { withRoute } = await import('@/lib/logging/with-route')
      const route = withRoute('crm/ai/slot:GET', async () =>
        Response.json(await rateLimit('altro-gruppo:123', opzioni)))
      const res = await route(new Request('https://test.invalid/api/crm/ai/slot'))
      expect(await res.json()).toMatchObject({ ok: true, remaining: 0 })
      rid = res.headers.get('x-request-id')
      expect(rid).toBeTruthy()
    }
    expect(h.tetto).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(righe()).toHaveLength(1))
    senzaDati()
    expect(righe()).toMatchObject([{
      livello: 'error', codice: 'XX000', messaggio: DIAGNOSI,
      contesto: { campi: { azione: 'client_assente', tipo: 'sconosciuto' } },
      ...(rid ? { request_id: rid } : {}),
    }])
  })

  it('il gruppo CRM AI non eredita il contesto ordinario quando il wrapper non c’è', async () => {
    h.tetto.mockRejectedValue(guasto('XX000'))
    const { rateLimit } = await import('@/lib/security/rate-limit')
    const { conContesto, contesto } = await import('@/lib/logging/context')
    const esterno = { requestId: TOKEN, path: '/api/' + NOME, userId: TELEFONO, payload: { body: { nome: NOME } } }
    const risultato = await conContesto(esterno, async () => {
      const esito = await rateLimit(CHIAVE, opzioni)
      expect(contesto()).toMatchObject(esterno)
      return esito
    })
    expect(risultato.ok).toBe(true)
    await vi.waitFor(() => expect(righe()).toHaveLength(1))
    senzaDati()
    expect(righe()).toMatchObject([{
      livello: 'error', codice: 'XX000', messaggio: DIAGNOSI,
      contesto: { campi: { azione: 'eccezione', tipo: 'crm-ai' } },
    }])
  })

  it('il gruppo CRM AI protegge il vero fetch della RPC prima del log di degrado', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch')
    const reteFinta = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: 'P0001:' + NOME,
      message: TESTO + ' ' + CHIAVE,
      details: TESTO,
      hint: TESTO,
    }, { status: 400 }))
    const client = createClient('https://test.invalid', 'chiave-finta-limite', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: creaFetchStrumentato(reteFinta) },
    })
    h.tetto.mockImplementation(async (nome, args) => await client.rpc(nome, args))
    const { rateLimit } = await import('@/lib/security/rate-limit')
    const { conContesto, contesto } = await import('@/lib/logging/context')
    const esterno = { requestId: TOKEN, path: '/api/' + NOME, userId: TELEFONO, payload: { body: { nome: NOME } } }
    const risultato = await conContesto(esterno, async () => {
      const esito = await rateLimit(CHIAVE, opzioni)
      expect(contesto()).toMatchObject(esterno)
      return esito
    })
    expect(risultato).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 })
    expect(reteFinta).toHaveBeenCalledExactlyOnceWith(
      'https://test.invalid/rest/v1/rpc/tetto_frequenza_consuma',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining(CHIAVE) }),
    )
    await vi.waitFor(() => expect(righe()).toHaveLength(2))
    senzaDati()
    expect(righe()).toEqual(expect.arrayContaining([
      expect.objectContaining({ evento: 'rpc', codice: 'supabase_http', messaggio: 'Errore HTTP Supabase' }),
      expect.objectContaining({ evento: 'db', codice: CODICE_RIPIEGO, messaggio: DIAGNOSI }),
    ]))
  })

  it('un altro gruppo mantiene i dettagli originali fuori dal contesto verificato', async () => {
    const message = 'Diagnosi sintetica ordinaria'
    h.tetto.mockResolvedValue({ error: { code: 'PGRST202', message } })
    const { rateLimit } = await import('@/lib/security/rate-limit')
    const { conContesto } = await import('@/lib/logging/context')
    const risultato = await conContesto(
      { requestId: 'legittimo', route: 'crm/ai/slot:GET', path: '/api/crm/ai/slot' },
      () => rateLimit('altro-gruppo:123', opzioni),
    )
    expect(risultato.ok).toBe(true)
    await vi.waitFor(() => expect(righe()).toHaveLength(1))
    expect(righe()).toMatchObject([{
      request_id: 'legittimo', livello: 'error', codice: 'PGRST202', messaggio: message,
      contesto: { campi: { azione: 'rpc_errore', tipo: 'altro-gruppo' } },
    }])
  })
})
