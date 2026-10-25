import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * POST /api/pagamenti/fattura/sync — UN GIRO ALLA VOLTA (sessione 8 della seconda serie, D12).
 * Il segreto si guarda prima della presa; con la presa d'altri il giro non parte; la presa si
 * rilascia anche quando il giro fallisce. Il finto database lancia alla prima lettura: basta a
 * sapere se il giro è partito.
 */

const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const h = vi.hoisted(() => ({
  prendi: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ esito: 'presa', token: null })),
  rilascia: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  from: vi.fn<(...a: unknown[]) => unknown>(() => { throw new Error('lettura finta fallita') }),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})
vi.mock('@/lib/cron/presa', () => ({ prendiPresaCron: h.prendi, rilasciaPresaCron: h.rilascia }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({ from: h.from }) }))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'

function req(secret?: string) {
  return new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('POST /api/pagamenti/fattura/sync — presa con scadenza sul giro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('senza segreto: 401, e la presa non si tocca', async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(h.prendi).not.toHaveBeenCalled()
  })

  it('presa d’altri: 200 «saltato», nessuna lettura, nessun rilascio', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'altrui' })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { saltato: 'presa-altrui' } })
    expect(h.from).not.toHaveBeenCalled()
    expect(h.rilascia).not.toHaveBeenCalled()
  })

  it('presa guasta: 503, nessuna lettura', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'guasto' })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(503)
    expect(h.from).not.toHaveBeenCalled()
  })

  it('presa ottenuta: il giro parte, e la presa si rilascia anche se il giro fallisce', async () => {
    h.prendi.mockResolvedValueOnce({ esito: 'presa', token: TOKEN })
    const res = await POST(req('topsecret'))
    expect(res.status).toBe(500)
    expect(h.from).toHaveBeenCalledWith('fatture_emesse')
    expect(h.logErrore).toHaveBeenCalledTimes(1)
    expect(h.rilascia).toHaveBeenCalledTimes(1)
    expect(h.rilascia.mock.calls[0].slice(1)).toEqual(['fattura-sync', TOKEN])
  })
})
