import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  vapidConfigured: vi.fn(),
  requireUser: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from: () => ({
      upsert: h.upsert,
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }),
  }),
}))
vi.mock('@/lib/push/web-push', () => ({ vapidConfigured: h.vapidConfigured }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))

import { POST } from '@/app/api/push/subscribe/route'

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.upsert.mockResolvedValue({ error: null })
  h.vapidConfigured.mockReturnValue(true)
  h.requireUser.mockResolvedValue({ user: { id: 'u1' } })
})

describe('POST /api/push/subscribe', () => {
  it('token nativo → 201 e upsert con platform, senza richiedere VAPID', async () => {
    h.vapidConfigured.mockReturnValue(false) // la registrazione nativa non dipende da VAPID
    const res = await POST(jsonReq({ token: 'fcm-tok', platform: 'android' }))
    expect(res.status).toBe(201)
    expect(h.upsert).toHaveBeenCalledTimes(1)
    expect(h.upsert.mock.calls[0][0]).toMatchObject({
      utente_id: 'u1',
      endpoint: 'fcm-tok',
      platform: 'android',
      p256dh: null,
      auth: null,
    })
  })

  it('subscription web con VAPID → 201 platform web', async () => {
    const res = await POST(
      jsonReq({ subscription: { endpoint: 'ep', keys: { p256dh: 'p', auth: 'a' } } })
    )
    expect(res.status).toBe(201)
    expect(h.upsert.mock.calls[0][0]).toMatchObject({
      endpoint: 'ep',
      platform: 'web',
      p256dh: 'p',
      auth: 'a',
    })
  })

  it('subscription web senza VAPID → 503 e nessun upsert', async () => {
    h.vapidConfigured.mockReturnValue(false)
    const res = await POST(
      jsonReq({ subscription: { endpoint: 'ep', keys: { p256dh: 'p', auth: 'a' } } })
    )
    expect(res.status).toBe(503)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('platform non valida → 400', async () => {
    const res = await POST(jsonReq({ token: 't', platform: 'windows' }))
    expect(res.status).toBe(400)
  })

  it('senza sessione → la risposta di requireUser (401)', async () => {
    h.requireUser.mockResolvedValue({ response: new Response('no', { status: 401 }) })
    const res = await POST(jsonReq({ token: 't', platform: 'ios' }))
    expect(res.status).toBe(401)
    expect(h.upsert).not.toHaveBeenCalled()
  })
})
