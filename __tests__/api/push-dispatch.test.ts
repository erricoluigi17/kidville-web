import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock generico: builder thenable (risolve per-tabella FIFO) + registro chiamate.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        const rec = (m: string) => (...args: unknown[]) => { state.calls.push({ table, m, args }); return qb }
        for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'update', 'delete', 'eq']) qb[m] = rec(m)
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const push = vi.hoisted(() => ({ sendPush: vi.fn(), vapidConfigured: vi.fn() }))
vi.mock('@/lib/push/web-push', () => push)
const native = vi.hoisted(() => ({ sendNativePush: vi.fn(), fcmConfigured: vi.fn() }))
vi.mock('@/lib/push/native-push', () => native)

import { POST } from '@/app/api/push/dispatch/route'

function req(secret?: string): Request {
  return new Request('http://localhost/api/push/dispatch', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.calls = []
  process.env.CRON_SECRET = 'test-secret'
  push.sendPush.mockResolvedValue({ ok: true })
  push.vapidConfigured.mockReturnValue(true)
  native.sendNativePush.mockResolvedValue({ ok: true })
  native.fcmConfigured.mockReturnValue(false) // default: FCM non configurato
})

describe('POST /api/push/dispatch', () => {
  it('401 senza secret o con secret errato', async () => {
    expect((await POST(req())).status).toBe(401)
    expect((await POST(req('wrong'))).status).toBe(401)
  })

  it('senza chiavi VAPID → 200 non_configurato, niente invii né marcature', async () => {
    push.vapidConfigured.mockReturnValue(false)
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ inviate: 0, non_configurato: true })
    expect(push.sendPush).not.toHaveBeenCalled()
    expect(h.state.calls).toHaveLength(0)
  })

  it('200 inviate:0 quando non ci sono notifiche pendenti', async () => {
    h.state.queues = { notifiche: [{ data: [], error: null }] }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.inviate).toBe(0)
    expect(push.sendPush).not.toHaveBeenCalled()
  })

  it('filtra solo non-inviate e buffer scaduto, invia e marca push_inviata_il', async () => {
    h.state.queues = {
      notifiche: [
        { data: [
          { id: 'n1', utente_id: 'u1', titolo: 't1', corpo: 'c1', link: '/' },
          { id: 'n2', utente_id: 'u2', titolo: 't2', corpo: null, link: null },
        ], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
          { id: 's2', utente_id: 'u2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
        ], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(push.sendPush).toHaveBeenCalledTimes(2)
    expect(body.data.inviate).toBe(2)
    expect(body.data.notifiche).toBe(2)
    // filtro buffer applicato a livello query
    expect(h.state.calls.some((c) => c.m === 'is' && c.args[0] === 'push_inviata_il' && c.args[1] === null)).toBe(true)
    expect(h.state.calls.some((c) => c.m === 'or' && String(c.args[0]).includes('invio_programmato_il'))).toBe(true)
    // marcatura inviate
    expect(h.state.calls.some((c) => c.table === 'notifiche' && c.m === 'update')).toBe(true)
  })

  it('rimuove le subscription "gone" (410/404)', async () => {
    push.sendPush.mockResolvedValueOnce({ ok: false, gone: true }).mockResolvedValue({ ok: true })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null },
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
          { id: 's2', utente_id: 'u1', endpoint: 'e2', p256dh: 'p', auth: 'a' },
        ], error: null },
        { data: null, error: null }, // delete
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(body.data.subs_rimosse).toBe(1)
    expect(h.state.calls.some((c) => c.table === 'push_subscriptions' && c.m === 'delete')).toBe(true)
  })

  it('instrada i token nativi a sendNativePush e i web a sendPush', async () => {
    native.fcmConfigured.mockReturnValue(true)
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: '/x' }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [
          { id: 's1', utente_id: 'u1', endpoint: 'webep', p256dh: 'p', auth: 'a', platform: 'web' },
          { id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'android' },
        ], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(push.sendPush).toHaveBeenCalledTimes(1)
    expect(native.sendNativePush).toHaveBeenCalledTimes(1)
    expect(native.sendNativePush).toHaveBeenCalledWith(
      'fcmtok',
      'android',
      expect.objectContaining({ title: 't', url: '/x' })
    )
    expect(body.data.inviate).toBe(1)
    expect(body.data.native_inviate).toBe(1)
  })

  it('FCM non configurato → token nativi saltati (degrado pulito), notifica comunque marcata', async () => {
    native.fcmConfigured.mockReturnValue(false) // web ok (beforeEach) → nessun early-return
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [{ id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'ios' }], error: null },
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(body.data.native_inviate).toBe(0)
    expect(h.state.calls.some((c) => c.table === 'notifiche' && c.m === 'update')).toBe(true)
  })

  it('rimuove il token nativo "gone"', async () => {
    native.fcmConfigured.mockReturnValue(true)
    native.sendNativePush.mockResolvedValue({ ok: false, gone: true })
    h.state.queues = {
      notifiche: [
        { data: [{ id: 'n1', utente_id: 'u1', titolo: 't', corpo: null, link: null }], error: null },
        { data: null, error: null }, // update
      ],
      push_subscriptions: [
        { data: [{ id: 's2', utente_id: 'u1', endpoint: 'fcmtok', p256dh: null, auth: null, platform: 'android' }], error: null },
        { data: null, error: null }, // delete
      ],
    }
    const res = await POST(req('test-secret'))
    const body = await res.json()
    expect(body.data.subs_rimosse).toBe(1)
    expect(h.state.calls.some((c) => c.table === 'push_subscriptions' && c.m === 'delete')).toBe(true)
  })
})
