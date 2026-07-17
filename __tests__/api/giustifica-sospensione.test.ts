import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// M4 — Morosità residua: il genitore SOSPESO non può giustificare un'assenza.
// La guardia va DOPO requireParentOfStudent e PRIMA della verifica OTP: un
// account sospeso non deve neppure innescare la firma. Blocca solo la SCRITTURA.

const STUDENT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const PARENT = 'u1u1u1u1-0000-4000-8000-000000000001'
const TODAY = new Date().toISOString().slice(0, 10)

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    updateCalled: 0,
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
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.update = () => { state.updateCalled++; return qb }
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient, requireParent: vi.fn(), assertGenitore: vi.fn() }
})

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn().mockResolvedValue(h.makeClient()) }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
const otp = vi.hoisted(() => ({ getUserEmail: vi.fn(), verifyTicket: vi.fn(), codeHash: vi.fn() }))
vi.mock('@/lib/auth/otp-ticket', () => otp)
const cfg = vi.hoisted(() => ({ getModuleConfig: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => cfg)
vi.mock('@/lib/fea/slots', () => ({ recordSignerSlot: vi.fn() }))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: vi.fn().mockResolvedValue([]) }))

import { POST } from '@/app/api/parent/presenze/giustifica/route'

const req = (body: unknown): NextRequest =>
  new NextRequest('http://localhost/api/parent/presenze/giustifica', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.updateCalled = 0
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  otp.getUserEmail.mockResolvedValue('genitore@example.it')
  otp.verifyTicket.mockReturnValue({ ok: true })
  otp.codeHash.mockReturnValue('SHA256-MOCKEDHASH')
  cfg.getModuleConfig.mockResolvedValue({ giustifica_max_giorni_retroattivi: 5, giustifica_richiede_firma_otp: true })
})

describe('POST /api/parent/presenze/giustifica — gate sospensione morosità (M4)', () => {
  it('genitore sospeso → 403, NESSUN update e OTP mai verificato', async () => {
    h.assertGenitore.mockResolvedValue(
      NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }),
    )
    const res = await POST(req({ studentId: STUDENT, data: TODAY, code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(403)
    expect(h.state.updateCalled).toBe(0)
    expect(otp.verifyTicket).not.toHaveBeenCalled()
    expect(h.assertGenitore).toHaveBeenCalledWith(expect.anything(), PARENT)
  })

  it('genitore non sospeso → 200 e giustifica registrata', async () => {
    h.assertGenitore.mockResolvedValue(null)
    h.state.queues = {
      alunni: [{ data: { id: STUDENT, section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }],
      sections: [{ data: { school_type: 'primaria' }, error: null }],
      presenze: [{ data: { id: 'p-1', giustificata: true }, error: null }],
    }
    const res = await POST(req({ studentId: STUDENT, data: TODAY, motivo: 'malattia', code: '424242', expiry: 999, ticket: 't' }))
    expect(res.status).toBe(200)
    expect(h.assertGenitore).toHaveBeenCalled()
  })
})
