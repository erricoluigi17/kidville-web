import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

// ── Caratterizzazione del path FIRMA LIVE del wizard moduli (P1/S0). ──
// Questo è il flusso che `OtpSignatureModal` invoca realmente. I test fissano
// status code + contratto JSON PRIMA del refactor FEA (rete di sicurezza R1).

// Mock table-aware: per ogni tabella una coda FIFO di risultati, consumata
// nell'ordine in cui la route esegue le query.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { update: [] as unknown[], upsert: [] as unknown[] },
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
        qb.upsert = (v: unknown) => { state.captured.upsert.push({ table, value: v }); return qb }
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

import { POST, PATCH } from '@/app/api/forms/send-otp/route'

function hashOtp(submissionId: string, code: string): string {
  return createHash('sha256').update(`${submissionId}:${code}`).digest('hex')
}

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/forms/send-otp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { update: [], upsert: [] }
})

describe('POST /api/forms/send-otp — crea submission + invia OTP', () => {
  it('400 se mancano modelId o data', async () => {
    const res = await POST(jsonReq({ userId: 'u-1' }))
    expect(res.status).toBe(400)
  })

  it('200 crea form_submissions(pending_signature) e ritorna submissionId/email/sent', async () => {
    h.state.queues = {
      form_submissions: [{ data: { id: 'sub-1' }, error: null }, { data: null, error: null }],
      utenti: [{ data: { email: 'genitore@example.it' }, error: null }],
    }
    const res = await POST(jsonReq({ modelId: 'm-1', userId: 'u-1', data: { campo: 'x' } }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ submissionId: 'sub-1', email: 'genitore@example.it', sent: true })
  })
})

describe('PATCH /api/forms/send-otp — verifica OTP e finalizza', () => {
  it('400 se mancano submissionId o code', async () => {
    const res = await PATCH(jsonReq({ submissionId: 'sub-1' }))
    expect(res.status).toBe(400)
  })

  it('404 se la submission non esiste', async () => {
    h.state.queues = { form_submissions: [{ data: null, error: null }] }
    const res = await PATCH(jsonReq({ submissionId: 'nope', code: '000000' }))
    expect(res.status).toBe(404)
  })

  it('409 se già completata', async () => {
    h.state.queues = {
      form_submissions: [{ data: { id: 'sub-1', otp_secret: 'x', status: 'completed' }, error: null }],
    }
    const res = await PATCH(jsonReq({ submissionId: 'sub-1', code: '123456' }))
    expect(res.status).toBe(409)
  })

  it('400 se il codice è errato', async () => {
    h.state.queues = {
      form_submissions: [
        { data: { id: 'sub-1', otp_secret: hashOtp('sub-1', '111111'), status: 'pending_signature' }, error: null },
      ],
    }
    const res = await PATCH(jsonReq({ submissionId: 'sub-1', code: '999999' }))
    expect(res.status).toBe(400)
  })

  it('200 con codice corretto → ok + signedAt', async () => {
    h.state.queues = {
      form_submissions: [
        { data: { id: 'sub-1', otp_secret: hashOtp('sub-1', '424242'), status: 'pending_signature' }, error: null },
        { data: null, error: null },
      ],
    }
    const res = await PATCH(jsonReq({ submissionId: 'sub-1', code: '424242' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.signedAt).toBe('string')
  })

  it('S7: salva signature_log su form_submissions + slot fea_signatures', async () => {
    h.state.queues = {
      form_submissions: [
        { data: { id: 'sub-1', otp_secret: hashOtp('sub-1', '424242'), status: 'pending_signature', user_id: 'u-1' }, error: null },
        { data: null, error: null },
      ],
    }
    await PATCH(jsonReq({ submissionId: 'sub-1', code: '424242' }))
    const updates = h.state.captured.update as Array<{ table: string; value: Record<string, unknown> }>
    const fsUpdate = updates.find((u) => u.table === 'form_submissions' && u.value.signature_log)
    expect(fsUpdate).toBeTruthy()
    const log = fsUpdate!.value.signature_log as Record<string, unknown>
    expect(log).toMatchObject({ method: 'OTP_EMAIL', compliance: 'CAD Art. 20 / DPR 445/2000' })
    expect(typeof log.hash).toBe('string')
    const slots = h.state.captured.upsert as Array<{ table: string }>
    expect(slots.some((u) => u.table === 'fea_signatures')).toBe(true)
  })
})
