import { describe, it, expect, beforeEach, vi } from 'vitest'

// Il modulo legge le credenziali da process.env → import fresco in ogni test.
async function freshModule() {
  vi.resetModules()
  return import('@/lib/push/native-push')
}

describe('native-push (FCM) — gating e degrado', () => {
  beforeEach(() => {
    delete process.env.FCM_PROJECT_ID
    delete process.env.FCM_CLIENT_EMAIL
    delete process.env.FCM_PRIVATE_KEY
    vi.restoreAllMocks()
  })

  it('fcmConfigured() è false senza credenziali', async () => {
    const { fcmConfigured } = await freshModule()
    expect(fcmConfigured()).toBe(false)
  })

  it('fcmConfigured() è true con tutte le credenziali', async () => {
    process.env.FCM_PROJECT_ID = 'proj'
    process.env.FCM_CLIENT_EMAIL = 'svc@proj.iam'
    process.env.FCM_PRIVATE_KEY = 'key'
    const { fcmConfigured } = await freshModule()
    expect(fcmConfigured()).toBe(true)
  })

  it('sendNativePush senza credenziali → { ok:false, error:fcm_non_configurato } e nessuna fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('token-abc', 'android', { title: 'Ciao', url: '/x' })
    expect(res).toEqual({ ok: false, error: 'fcm_non_configurato' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sendNativePush non lancia mai, anche con credenziali non valide', async () => {
    process.env.FCM_PROJECT_ID = 'proj'
    process.env.FCM_CLIENT_EMAIL = 'svc@proj.iam'
    process.env.FCM_PRIVATE_KEY = 'chiave-non-valida' // la firma RS256 fallirà → catch → esito pulito
    const { sendNativePush } = await freshModule()
    const res = await sendNativePush('token-abc', 'ios', { title: 'x' })
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
  })
})
