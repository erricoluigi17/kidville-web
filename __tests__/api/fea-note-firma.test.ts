import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── P2/Slice 2 — Presa visione note via FEA (DL-014). ──
// Specchio del flusso pagella/firma: OTP/FES → signature_log in nota_ricezioni
// + slot firmatari + audit immutabile; note_disciplinari.firmata_il per retro-compat.

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { upsert: [] as unknown[], update: [] as unknown[], insert: [] as unknown[] },
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
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.captured.insert.push(v); return qb }
        qb.update = (v: unknown) => { state.captured.update.push({ table, v }); return qb }
        qb.upsert = (v: unknown) => { state.captured.upsert.push({ table, v }); return qb }
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
const auth = vi.hoisted(() => ({ getRequestUserId: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ getRequestUserId: auth.getRequestUserId }))
const otp = vi.hoisted(() => ({ getUserEmail: vi.fn(), verifyTicket: vi.fn(), codeHash: vi.fn() }))
vi.mock('@/lib/auth/otp-ticket', () => otp)

import { POST } from '@/app/api/parent/primaria/note/firma/route'
import { NextRequest } from 'next/server'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/parent/primaria/note/firma?userId=u-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { upsert: [], update: [], insert: [] }
  auth.getRequestUserId.mockReturnValue('u-1')
  otp.getUserEmail.mockResolvedValue('genitore@example.it')
  otp.verifyTicket.mockReturnValue({ ok: true })
  otp.codeHash.mockReturnValue('SHA256-MOCKEDHASH')
})

describe('POST /api/parent/primaria/note/firma', () => {
  it('401 senza userId', async () => {
    auth.getRequestUserId.mockReturnValue(null)
    const res = await POST(req({ notaId: 'n-1' }))
    expect(res.status).toBe(401)
  })

  it('400 senza notaId', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it('400 se email genitore non trovata', async () => {
    otp.getUserEmail.mockResolvedValue(null)
    const res = await POST(req({ notaId: 'n-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(400)
  })

  it('400 OTP non valido + audit verify_failed', async () => {
    otp.verifyTicket.mockReturnValue({ ok: false, error: 'Codice non valido' })
    const res = await POST(req({ notaId: 'n-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(400)
    const audits = h.state.captured.insert as Array<{ evento?: string }>
    expect(audits.some((a) => a.evento === 'verify_failed')).toBe(true)
  })

  it('404 se nota non trovata', async () => {
    h.state.queues = { note_disciplinari: [{ data: null, error: null }] }
    const res = await POST(req({ notaId: 'n-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(404)
  })

  it('200 firma → nota_ricezioni con signature_log + audit signed + firmata_il', async () => {
    h.state.queues = {
      note_disciplinari: [{ data: { id: 'n-1', alunno_id: 'a-1', richiede_firma: true }, error: null }],
      nota_ricezioni: [{ data: { id: 'r-1' }, error: null }],
    }
    const res = await POST(req({ notaId: 'n-1', code: '424242', expiry: 999, ticket: 't' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)

    const ric = (h.state.captured.upsert as Array<{ table: string; v: { firma: Record<string, unknown> } }>)
      .find((c) => c.table === 'nota_ricezioni')
    expect(ric).toBeTruthy()
    expect(ric!.v.firma).toMatchObject({
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email: 'genitore@example.it',
      ip: '203.0.113.7',
      hash: 'SHA256-MOCKEDHASH',
      compliance: 'CAD Art. 20 / DPR 445/2000',
    })

    // Retro-compat: timestamp di presa visione sulla nota.
    const upd = (h.state.captured.update as Array<{ table: string; v: Record<string, unknown> }>)
      .find((c) => c.table === 'note_disciplinari')
    expect(upd).toBeTruthy()
    expect(upd!.v.firmata_il).toBeTruthy()

    // Audit immutabile dell'evento di firma.
    const audits = h.state.captured.insert as Array<{ evento?: string; hash?: string }>
    expect(audits.some((a) => a.evento === 'signed' && a.hash === 'SHA256-MOCKEDHASH')).toBe(true)
  })
})
