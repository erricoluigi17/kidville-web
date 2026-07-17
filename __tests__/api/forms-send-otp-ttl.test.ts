import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// m4 — OTP Sistema A con scadenza 10 minuti (allineato al Sistema B, OTP_TTL_MS).
// La verifica (PATCH /api/forms/send-otp) rifiuta un codice il cui
// `otp_generato_il` è più vecchio di 10 minuti; degrada se la colonna manca.

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { update: [] as unknown[] },
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'insert', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.update = (v: unknown) => { state.captured.update.push({ table, value: v }); return qb }
        qb.upsert = () => qb
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
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
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 7, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('test-ip'),
}))

import { PATCH } from '@/app/api/forms/send-otp/route'

const SID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12'

function hashOtp(submissionId: string, code: string): string {
  return createHash('sha256').update(`${submissionId}:${code}`).digest('hex')
}

function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/forms/send-otp', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { update: [] }
})

describe('PATCH /api/forms/send-otp — TTL 10 minuti (m4)', () => {
  it('codice corretto ma otp_generato_il oltre 10 minuti → 400 scaduto', async () => {
    h.state.queues = {
      form_submissions: [
        {
          data: {
            id: SID,
            otp_secret: hashOtp(SID, '424242'),
            status: 'pending_signature',
            otp_generato_il: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
          },
          error: null,
        },
        { data: null, error: null },
      ],
    }
    const res = await PATCH(patchReq({ submissionId: SID, code: '424242' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(String(body.error).toLowerCase()).toContain('scadut')
  })

  it('codice corretto e otp_generato_il recente → 200', async () => {
    h.state.queues = {
      form_submissions: [
        {
          data: {
            id: SID,
            otp_secret: hashOtp(SID, '424242'),
            status: 'pending_signature',
            otp_generato_il: new Date().toISOString(),
          },
          error: null,
        },
        { data: null, error: null },
      ],
    }
    const res = await PATCH(patchReq({ submissionId: SID, code: '424242' }))
    expect(res.status).toBe(200)
  })

  it('otp_generato_il assente/null (DB non migrato) → comportamento attuale (200)', async () => {
    h.state.queues = {
      form_submissions: [
        { data: { id: SID, otp_secret: hashOtp(SID, '424242'), status: 'pending_signature' }, error: null },
        { data: null, error: null },
      ],
    }
    const res = await PATCH(patchReq({ submissionId: SID, code: '424242' }))
    expect(res.status).toBe(200)
  })
})
