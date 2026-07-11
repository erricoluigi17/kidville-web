import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  calls: [] as { op: string; args: unknown[] }[],
  legami: [] as { alunno_id: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      const rec = (op: string) => (...args: unknown[]) => { h.calls.push({ op: `${table}.${op}`, args }); return b }
      b.select = rec('select')
      b.order = rec('order')
      b.eq = rec('eq')
      b.in = rec('in')
      b.or = rec('or')
      b.gte = rec('gte')
      b.lte = rec('lte')
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'legame_genitori_alunni' ? h.legami : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'

const url = (qs: string) => new Request(`http://localhost/api/pagamenti?${qs}`) as unknown as import('next/server').NextRequest
const opDi = (op: string) => h.calls.filter((c) => c.op === op)

describe('GET /api/pagamenti — filtri staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.calls.length = 0
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('la SEGRETERIA usa il ramo staff (scoping sedi, niente lookup legami)', async () => {
    const res = await GET(url(''))
    expect(res.status).toBe(200)
    expect(opDi('pagamenti.in').some((c) => c.args[0] === 'scuola_id')).toBe(true)
    expect(h.calls.some((c) => c.op.startsWith('legame_genitori_alunni'))).toBe(false)
  })

  it('scadenza_da/scadenza_a → gte/lte su scadenza', async () => {
    await GET(url('scadenza_da=2026-07-01&scadenza_a=2026-07-31'))
    expect(opDi('pagamenti.gte')[0]?.args).toEqual(['scadenza', '2026-07-01'])
    expect(opDi('pagamenti.lte')[0]?.args).toEqual(['scadenza', '2026-07-31'])
  })

  it('fattura_stato valido → eq; valore fuori enum → 400', async () => {
    await GET(url('fattura_stato=emessa'))
    expect(opDi('pagamenti.eq').some((c) => c.args[0] === 'fattura_stato' && c.args[1] === 'emessa')).toBe(true)
    const res = await GET(url('fattura_stato=boh'))
    expect(res.status).toBe(400)
  })

  it('solo_aperti=true → in(stato, aperti)', async () => {
    await GET(url('solo_aperti=true'))
    const call = opDi('pagamenti.in').find((c) => c.args[0] === 'stato')
    expect(call?.args[1]).toEqual(['da_pagare', 'parziale', 'scaduto'])
  })
})
