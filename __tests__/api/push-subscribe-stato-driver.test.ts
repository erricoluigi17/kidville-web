import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostgrestClient } from '@supabase/postgrest-js'

/**
 * `GET /api/push/subscribe` — LA HEAD-QUERY COL DRIVER VERO (revisione di qualità, 2026-09-30).
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ACCANTO ALL'ALTRO ────────────────────────────────
 *
 * `push-subscribe-stato.test.ts` finge il valore di ritorno: `{ count, error, status }` scritto
 * a mano. Comodo, ma può descrivere risposte che il driver non produce MAI — per esempio un
 * `error.message` pieno su una HEAD. Qui gira `postgrest-js` vero su un PostgREST finto, e la
 * differenza è precisamente il difetto che questo test blocca:
 *
 * **su una HEAD il corpo è vuoto, per HTTP.** Quindi il driver non ha da cosa costruire un
 * errore: un **404** (tabella fuori dalla schema cache, `PGRST205`) arriva come
 * `{ error: null, count: null, status: 404 }`. Con un `count ?? 0` la route risponderebbe
 * «zero dispositivi» — e l'avviso «Le notifiche sono spente» comparirebbe a TUTTE le docenti
 * nello stesso momento, per un guasto di lettura.
 *
 * L'altra faccia: su un 5xx l'errore c'è ma ha `message` VUOTO. È il motivo per cui il log
 * porta lo `stato` HTTP — l'unica diagnosi che su questa query esiste davvero.
 */

const h = vi.hoisted(() => ({
  stato: 404,
  conteggio: '0-0/7',
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    new PostgrestClient('http://localhost:54321/rest/v1', {
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        h.fetch(String(url), init?.method)
        // Nessun corpo, qualunque sia lo stato: è HTTP, non una scelta di PostgREST.
        return new Response(null, {
          status: h.stato,
          headers: h.stato === 200 ? { 'content-range': h.conteggio } : {},
        })
      }) as typeof fetch,
    }),
}))
vi.mock('@/lib/push/web-push', () => ({ vapidConfigured: () => true }))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: async () => ({ user: { id: 'aaaaaaaa-1111-4000-8000-000000000001' } }),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: vi.fn() }))

import { GET } from '@/app/api/push/subscribe/route'

const richiesta = () => new Request('http://localhost/api/push/subscribe')

beforeEach(() => {
  vi.clearAllMocks()
  h.stato = 200
  h.conteggio = '0-0/7'
})

describe('GET /api/push/subscribe — col driver vero', () => {
  it('la query è davvero una HEAD sulla tabella giusta (nessuna riga trasferita)', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(h.fetch).toHaveBeenCalledWith(expect.stringContaining('/push_subscriptions'), 'HEAD')
  })

  it('200 con `content-range` → il conteggio vero, non uno zero di comodo', async () => {
    h.conteggio = '0-0/7'
    expect(await (await GET(richiesta())).json()).toEqual({ success: true, dispositivi: 7 })
  })

  it('🔴 404 senza corpo (`PGRST205`) → 500 col codice, MAI `dispositivi: 0`', async () => {
    h.stato = 404
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'PUSH_STATO_NON_LETTO' })
    // ⚠️ NEL LOG LO STATO È **204**, NON 404, e non è un errore di questo test: il driver
    // riscrive così il 404 con corpo vuoto (`postgrest-js`, `dist/index.cjs`: «if
    // (res.status === 404 && body === "") { status = 204; statusText = "No Content" }»).
    // Asserire 404 vorrebbe dire descrivere una risposta che il driver non produce mai — cioè
    // l'errore per cui questo file esiste. La firma diagnostica del caso è la TERNA:
    // `error: null` + `count: null` + `stato: 204`.
    expect(h.logEvento).toHaveBeenCalledWith(
      'push',
      'error',
      expect.objectContaining({ esito: 'stato-non-letto', stato: 204 }),
      undefined,
    )
  })

  it('500 senza corpo → 500 col codice, e nel log lo stato (il `message` del driver è vuoto)', async () => {
    h.stato = 500
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    expect(h.logEvento).toHaveBeenCalledWith(
      'push',
      'error',
      expect.objectContaining({ esito: 'stato-non-letto', stato: 500 }),
      expect.anything(),
    )
  })

  it('401 (chiave rifiutata) → 500 col codice: un guasto di lettura non diventa «non ne hai»', async () => {
    h.stato = 401
    const res = await GET(richiesta())
    expect(res.status).toBe(500)
    expect(h.logEvento).toHaveBeenCalledWith(
      'push',
      'error',
      expect.objectContaining({ stato: 401 }),
      expect.anything(),
    )
  })
})
