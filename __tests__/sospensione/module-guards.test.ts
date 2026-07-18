import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createHash } from 'crypto'

// S5 — chiusura dei rami-modulo scoperti (finding #4) + eccezione sempre_firmabile.
// La variante è MOCKATA e delega sul flag (come la reale): così si verifica il
// WIRING della route (legge il flag del modulo giusto e lo passa alla guardia).
const h = vi.hoisted(() => ({
  sospeso: true,
  submission: null as Record<string, unknown> | null,
  model: null as Record<string, unknown> | null,
  template: null as Record<string, unknown> | null,
  updates: 0,
  persistCalls: 0,
  variantCalls: [] as { sempreFirmabile: unknown }[],
}))

vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn(async () => (h.sospeso ? NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }) : null)),
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(async (_sb: unknown, _id: unknown, opts: { sempreFirmabile?: boolean }) => {
    h.variantCalls.push({ sempreFirmabile: opts?.sempreFirmabile })
    if (opts?.sempreFirmabile) return null // essenziale: mai bloccato
    return h.sospeso ? NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }) : null
  }),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => 'ip' }))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockResolvedValue({ user: { id: 'g1', role: 'genitore', scuola_id: null } }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: vi.fn(async () => true) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => {}) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [], scuolaUnicaReale: async () => 's1' }))
vi.mock('@/lib/forms/persist-submission', () => ({
  persistSignedSubmission: vi.fn(async () => { h.persistCalls++; return { submission: { id: 'sub-1' }, status: 201 } }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = async () => ({ data: [], error: null })
      b.maybeSingle = async () => ({
        data:
          table === 'form_submissions' ? h.submission
          : table === 'form_models' ? h.model
          : table === 'forms_templates' ? h.template
          : table === 'utenti' ? { email: 'p@x.it' }
          : null,
        error: null,
      })
      b.single = async () => ({ data: { id: 'sub-new' }, error: null })
      b.insert = () => b
      b.update = () => ({ eq: async () => { h.updates++; return { error: null } } })
      return b
    },
  }),
}))

const hashOtp = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex')

import { POST as SEND_OTP_POST, PATCH as SEND_OTP_PATCH } from '@/app/api/forms/send-otp/route'
import { POST as PARENT_SUB_POST } from '@/app/api/parent/submissions/route'

const M1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10'
const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12'
const T1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10'
const ST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb20'

const sendReq = (body: unknown, method: 'POST' | 'PATCH' = 'POST') =>
  new Request('http://localhost/api/forms/send-otp', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const subReq = (body: unknown) =>
  new Request('http://localhost/api/parent/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.sospeso = true
  h.submission = null
  h.model = { sempre_firmabile: false, signature_mode: 'single' }
  h.template = { sempre_firmabile: false }
  h.updates = 0
  h.persistCalls = 0
  h.variantCalls = []
})

describe('forms/send-otp — ramo REINVIO/2° firmatario (finding #4)', () => {
  it('genitore sospeso, modulo non essenziale → 403 (OTP non re-inviato)', async () => {
    h.submission = { id: SUB, status: 'pending_signature', user_id: 'g1', model_id: M1 }
    const res = await SEND_OTP_POST(sendReq({ submissionId: SUB }))
    expect(res.status).toBe(403)
    expect(h.variantCalls.at(-1)?.sempreFirmabile).toBe(false)
  })

  it('modulo essenziale (sempre_firmabile=true) → reinvio consentito anche se sospeso', async () => {
    h.submission = { id: SUB, status: 'pending_signature', user_id: 'g1', model_id: M1 }
    h.model = { sempre_firmabile: true, signature_mode: 'single' }
    const res = await SEND_OTP_POST(sendReq({ submissionId: SUB }))
    expect(res.status).toBe(200)
    expect(h.variantCalls.at(-1)?.sempreFirmabile).toBe(true)
  })
})

describe('forms/send-otp — PATCH di verifica (finding #4)', () => {
  it('genitore sospeso, non essenziale → 403 (firma non finalizzata)', async () => {
    h.submission = { id: SUB, otp_secret: hashOtp(SUB, '000000'), status: 'pending_signature', user_id: 'g1', model_id: M1 }
    const res = await SEND_OTP_PATCH(sendReq({ submissionId: SUB, code: '000000' }, 'PATCH'))
    expect(res.status).toBe(403)
  })

  it('modulo essenziale → il guard non blocca', async () => {
    h.submission = { id: SUB, otp_secret: hashOtp(SUB, '000000'), status: 'pending_signature', user_id: 'g1', model_id: M1 }
    h.model = { sempre_firmabile: true, signature_mode: 'single' }
    const res = await SEND_OTP_PATCH(sendReq({ submissionId: SUB, code: '000000' }, 'PATCH'))
    expect(res.status).not.toBe(403)
  })
})

describe('parent/submissions — POST (ramo scoperto, finding #4)', () => {
  it('genitore sospeso, template non essenziale → 403 (submission non creata)', async () => {
    const res = await PARENT_SUB_POST(subReq({ form_id: T1, student_id: ST, answers: { a: 1 } }))
    expect(res.status).toBe(403)
    expect(h.persistCalls).toBe(0)
  })

  it('template essenziale (sempre_firmabile=true) → submission consentita', async () => {
    h.template = { sempre_firmabile: true }
    const res = await PARENT_SUB_POST(subReq({ form_id: T1, student_id: ST, answers: { a: 1 } }))
    expect(res.status).toBe(201)
    expect(h.persistCalls).toBe(1)
  })
})
