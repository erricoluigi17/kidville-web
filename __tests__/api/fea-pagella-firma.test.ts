import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Caratterizzazione firma ricezione PAGELLA (P1/S0). ──
// Fissa status code + forma dell'oggetto `firma` (signature_log) salvato in
// pagella_ricezioni, prima del refactor sul servizio FEA.

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
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.captured.insert.push(v); return qb }
        qb.update = (v: unknown) => { state.captured.update.push(v); return qb }
        qb.upsert = (v: unknown) => { state.captured.upsert.push(v); return qb }
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
const auth = vi.hoisted(() => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: auth.requireParentOfStudent }))
const otp = vi.hoisted(() => ({
  getUserEmail: vi.fn(),
  verifyTicket: vi.fn(),
  codeHash: vi.fn(),
}))
vi.mock('@/lib/auth/otp-ticket', () => otp)

import { POST } from '@/app/api/parent/primaria/pagella/firma/route'
import { NextRequest, NextResponse } from 'next/server'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/parent/primaria/pagella/firma?userId=u-1', {
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
  auth.requireParentOfStudent.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' }, response: null })
  otp.getUserEmail.mockResolvedValue('genitore@example.it')
  otp.verifyTicket.mockReturnValue({ ok: true })
  otp.codeHash.mockReturnValue('SHA256-MOCKEDHASH')
})

describe('POST /api/parent/primaria/pagella/firma', () => {
  it('401 senza sessione', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(401)
  })

  it('403 se la pagella è di un figlio non proprio (IDOR)', async () => {
    auth.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-2', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(403)
  })

  it('400 se mancano scrutinioId/studentId', async () => {
    const res = await POST(req({ scrutinioId: 's-1' }))
    expect(res.status).toBe(400)
  })

  it('400 se email genitore non trovata', async () => {
    otp.getUserEmail.mockResolvedValue(null)
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(400)
  })

  it('400 se OTP non valido + audit verify_failed', async () => {
    otp.verifyTicket.mockReturnValue({ ok: false, error: 'Codice non valido' })
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(400)
    const audits = h.state.captured.insert as Array<{ evento?: string }>
    expect(audits.some((a) => a.evento === 'verify_failed')).toBe(true)
  })

  it('404 se scrutinio non trovato', async () => {
    h.state.queues = { scrutini: [{ data: null, error: null }] }
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(404)
  })

  it('403 se pagella non pubblicata', async () => {
    h.state.queues = { scrutini: [{ data: { id: 's-1', pubblicato: false }, error: null }] }
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(403)
  })

  it('200 firma con signature_log {method,provider,email,ip,timestamp,hash,compliance}', async () => {
    h.state.queues = {
      scrutini: [{ data: { id: 's-1', pubblicato: true }, error: null }],
      pagella_ricezioni: [{ data: { id: 'r-1' }, error: null }],
    }
    const res = await POST(req({ scrutinioId: 's-1', studentId: 'a-1', code: '424242', expiry: 999, ticket: 't' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const upserted = h.state.captured.upsert[0] as { firma: Record<string, unknown> }
    expect(upserted.firma).toMatchObject({
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email: 'genitore@example.it',
      ip: '203.0.113.7',
      hash: 'SHA256-MOCKEDHASH',
      compliance: 'CAD Art. 20 / DPR 445/2000',
    })
    expect(typeof upserted.firma.timestamp).toBe('string')
    // S4: audit immutabile dell'evento di firma
    const audits = h.state.captured.insert as Array<{ evento?: string; hash?: string }>
    expect(audits.some((a) => a.evento === 'signed' && a.hash === 'SHA256-MOCKEDHASH')).toBe(true)
  })
})
