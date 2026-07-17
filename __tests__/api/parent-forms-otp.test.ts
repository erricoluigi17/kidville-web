import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { makeTicket } from '@/lib/auth/otp-ticket'

// M5 (replay) + B4/M4 (morosità) sul flusso di firma OTP Sistema B.
// Usa il REALE otp-ticket (verifyTicket + consumeTicket): solo lo store DB e i
// gate esterni sono mockati.

const h = vi.hoisted(() => ({
  consumati: new Set<string>(),
  sospeso: null as null | ReturnType<typeof NextResponse.json>,
  hasFiglio: true,
  persistCalls: 0,
  emailCalls: 0,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from(table: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit', 'in', 'update']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({ data: { email: 'p@x.it', nome: 'N', cognome: 'C' }, error: null })
      qb.single = () => Promise.resolve({ data: { email: 'p@x.it', nome: 'N', cognome: 'C' }, error: null })
      qb.insert = (v: { jti?: string }) => {
        if (table === 'otp_ticket_consumati') {
          const jti = String(v.jti)
          if (h.consumati.has(jti)) return Promise.resolve({ error: { code: '23505' } })
          h.consumati.add(jti)
          return Promise.resolve({ error: null })
        }
        return Promise.resolve({ error: null })
      }
      return qb
    },
  }),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockResolvedValue({
    user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', role: 'genitore', scuola_id: null },
  }),
}))

vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn().mockImplementation(async () => h.hasFiglio),
}))

vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn().mockImplementation(async () => h.sospeso),
}))

vi.mock('@/lib/forms/persist-submission', () => ({
  persistSignedSubmission: vi.fn().mockImplementation(async () => {
    h.persistCalls++
    return { submission: { id: 'sub-1' }, status: 201 }
  }),
}))

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn().mockImplementation(async () => {
    h.emailCalls++
    return true
  }),
}))

import { POST, PATCH } from '@/app/api/parent/forms/otp/route'

const FORM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10'
const STUDENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa20'

function patchReq(body: unknown) {
  return new Request('http://localhost/api/parent/forms/otp', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

function postReq() {
  return new Request('http://localhost/api/parent/forms/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }) as never
}

function firmaBody() {
  const code = '424242'
  const expiry = Date.now() + 10 * 60 * 1000
  const ticket = makeTicket('p@x.it', code, expiry)
  return { code, expiry, ticket, form_id: FORM_ID, student_id: STUDENT_ID, answers: { a: 1 } }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.consumati = new Set()
  h.sospeso = null
  h.hasFiglio = true
  h.persistCalls = 0
  h.emailCalls = 0
})

describe('PATCH /api/parent/forms/otp — anti-replay (M5)', () => {
  it('prima firma → 201; replay dello stesso ticket → 409', async () => {
    const body = firmaBody()
    const r1 = await PATCH(patchReq(body))
    expect(r1.status).toBe(201)

    const r2 = await PATCH(patchReq(body))
    expect(r2.status).toBe(409)
    // La seconda volta NON deve persistere una nuova submission.
    expect(h.persistCalls).toBe(1)
  })
})

describe('PATCH /api/parent/forms/otp — morosità (B4)', () => {
  it('genitore sospeso → 403 e nessuna firma persistita', async () => {
    h.sospeso = NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 })
    const r = await PATCH(patchReq(firmaBody()))
    expect(r.status).toBe(403)
    expect(h.persistCalls).toBe(0)
  })
})

describe('POST /api/parent/forms/otp — morosità (B4)', () => {
  it('genitore sospeso → 403 e nessuna email OTP inviata', async () => {
    h.sospeso = NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 })
    const r = await POST(postReq())
    expect(r.status).toBe(403)
    expect(h.emailCalls).toBe(0)
  })

  it('genitore non sospeso → 200 e OTP inviato', async () => {
    const r = await POST(postReq())
    expect(r.status).toBe(200)
    expect(h.emailCalls).toBe(1)
  })
})
