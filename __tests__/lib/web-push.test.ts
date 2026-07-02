import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}))

vi.mock('web-push', () => ({
  default: { setVapidDetails: h.setVapidDetails, sendNotification: h.sendNotification },
}))

const SUB = { endpoint: 'https://push.example/ep', p256dh: 'p', auth: 'a' }
const PAYLOAD = { title: 'Ciao' }

// Il modulo memoizza la configurazione VAPID → import fresco in ogni test.
async function freshModule() {
  vi.resetModules()
  return import('@/lib/push/web-push')
}

describe('web-push senza chiavi VAPID (degrado graceful)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })

  it('vapidConfigured() è false', async () => {
    const { vapidConfigured } = await freshModule()
    expect(vapidConfigured()).toBe(false)
  })

  it('sendPush non lancia: { ok:false, error:vapid_non_configurato }', async () => {
    const { sendPush } = await freshModule()
    const res = await sendPush(SUB, PAYLOAD)
    expect(res).toEqual({ ok: false, error: 'vapid_non_configurato' })
    expect(h.setVapidDetails).not.toHaveBeenCalled()
    expect(h.sendNotification).not.toHaveBeenCalled()
  })
})

describe('web-push con chiavi VAPID', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub-key'
    process.env.VAPID_PRIVATE_KEY = 'priv-key'
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })

  it('vapidConfigured() è true', async () => {
    const { vapidConfigured } = await freshModule()
    expect(vapidConfigured()).toBe(true)
  })

  it('invio riuscito → { ok:true } e configura una sola volta', async () => {
    h.sendNotification.mockResolvedValue({})
    const { sendPush } = await freshModule()
    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: true })
    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: true })
    expect(h.setVapidDetails).toHaveBeenCalledTimes(1)
    expect(h.sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: SUB.p256dh, auth: SUB.auth } },
      JSON.stringify(PAYLOAD)
    )
  })

  it('subscription scaduta (410) → { ok:false, gone:true }', async () => {
    h.sendNotification.mockRejectedValue({ statusCode: 410 })
    const { sendPush } = await freshModule()
    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: false, gone: true })
  })

  it('errore generico → { ok:false, error }', async () => {
    h.sendNotification.mockRejectedValue(new Error('boom'))
    const { sendPush } = await freshModule()
    expect(await sendPush(SUB, PAYLOAD)).toEqual({ ok: false, error: 'boom' })
  })
})
