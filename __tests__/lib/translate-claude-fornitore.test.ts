// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * SESSIONE 9 (seconda serie di robustezza) — la traduzione col fornitore osservato.
 *
 * Lo SDK VERO (`@anthropic-ai/sdk`), con un `fetch` finto sotto `externalFetch`: si guarda quante
 * chiamate fa, con che tetto nasce il client, e che righe lascia. Ambiente `node`: in jsdom lo
 * SDK si rifiuta di partire («browser-like environment»). Nessuna attesa vera: le attese che il
 * fornitore chiede qui sono 0.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

import {
  translateText, opzioniClientTraduzione, fetchOsservato, TIMEOUT_TRADUZIONE_MS, RITENTATIVI_TRADUZIONE,
} from '@/lib/translate/claude'

const URL_MESSAGGI = 'https://api.anthropic.com/v1/messages'

/** Anthropic finto: risponde in ordine con `risposte` (l'ultima si ripete) e conta le chiamate. */
function anthropicFinto(risposte: Array<() => Response>): { n: number } {
  const conto = { n: 0 }
  vi.stubGlobal('fetch', vi.fn(async () => {
    conto.n++
    return (risposte[conto.n - 1] ?? risposte[risposte.length - 1])()
  }))
  return conto
}

const tradotto = (testo: string) => () => new Response(JSON.stringify({
  id: 'msg_finto', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: testo }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

const rifiuto = (status: number, headers: Record<string, string> = {}) => () => new Response(
  JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
)

/** Le righe di `externalFetch` per il fornitore: [livello, stato]. */
const righeFornitore = () => log.logEvento.mock.calls
  .filter((c) => c[0] === 'traduzione' && (c[2] as { operazione?: string }).operazione === 'messages:create')
  .map((c) => [c[1], (c[2] as { stato: number }).stato])

beforeEach(() => {
  log.logEvento.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('translateText — il fornitore con i numeri scritti', () => {
  it('il client nasce con tetto, ritentativi e fetch osservato espliciti', () => {
    expect(opzioniClientTraduzione('chiave-finta')).toEqual({
      apiKey: 'chiave-finta', timeout: TIMEOUT_TRADUZIONE_MS, maxRetries: RITENTATIVI_TRADUZIONE, fetch: fetchOsservato,
    })
    expect(TIMEOUT_TRADUZIONE_MS).toBe(20_000)
    expect(RITENTATIVI_TRADUZIONE).toBe(1)
  })

  it('successo: una chiamata, una riga `info` del fornitore con lo stato', async () => {
    const conto = anthropicFinto([tradotto('Good morning')])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: 'Good morning' })
    expect(conto.n).toBe(1)
    expect(righeFornitore()).toEqual([['info', 200]])
    const riga = log.logEvento.mock.calls.find((c) => (c[2] as { operazione?: string }).operazione === 'messages:create')
    expect(riga?.[2]).toMatchObject({ provider: 'anthropic', stato: 200 })
  })

  it('529 (sovraccarico) con `Retry-After: 0`, poi 200: UN ritentativo, due righe', async () => {
    const conto = anthropicFinto([rifiuto(529, { 'retry-after': '0' }), tradotto('Good morning')])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r.translated).toBe('Good morning')
    expect(conto.n).toBe(2)
    expect(righeFornitore()).toEqual([['warn', 529], ['info', 200]])
  })

  it('429 con `Retry-After: 30` (oltre 5 s): nessun ritentativo, traduzione nulla, riga `error`', async () => {
    const conto = anthropicFinto([rifiuto(429, { 'retry-after': '30' })])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: null })
    expect(conto.n).toBe(1)
    const fallita = log.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === 'traduzione-fallita')
    expect(fallita).toHaveLength(1)
    expect(fallita[0][1]).toBe('error')
  })

  it('400 (definitivo): nessun ritentativo, riga `error` del fornitore', async () => {
    const conto = anthropicFinto([rifiuto(400)])
    const r = await translateText('Buongiorno', 'en', { apiKey: 'chiave-finta' })
    expect(r).toEqual({ translated: null })
    expect(conto.n).toBe(1)
    expect(righeFornitore()).toEqual([['error', 400]])
  })
})

describe('fetchOsservato — il rifiuto tradotto per lo SDK', () => {
  it('500 con `Retry-After: 2` ⇒ `retry-after-ms: 2000`', async () => {
    anthropicFinto([rifiuto(500, { 'retry-after': '2' })])
    const res = await fetchOsservato(URL_MESSAGGI, { method: 'POST' })
    expect(res.status).toBe(500)
    expect(res.headers.get('retry-after-ms')).toBe('2000')
    expect(res.headers.get('x-should-retry')).toBeNull()
  })

  it('429 con `Retry-After: 30` ⇒ `x-should-retry: false`', async () => {
    anthropicFinto([rifiuto(429, { 'retry-after': '30' })])
    const res = await fetchOsservato(URL_MESSAGGI, { method: 'POST' })
    expect(res.status).toBe(429)
    expect(res.headers.get('x-should-retry')).toBe('false')
  })

  it('richiesta interrotta dallo SDK (il suo tetto) ⇒ `AbortError`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('This operation was aborted', 'AbortError') }))
    const c = new AbortController()
    c.abort()
    await expect(fetchOsservato(URL_MESSAGGI, { method: 'POST', signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rete giù ⇒ un errore, che lo SDK tratta come errore di connessione', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }))
    await expect(fetchOsservato(URL_MESSAGGI, { method: 'POST' })).rejects.toThrow(/fetch failed/)
  })
})
