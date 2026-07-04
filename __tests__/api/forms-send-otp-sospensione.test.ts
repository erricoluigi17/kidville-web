import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  assertGenitore: vi.fn(),
  insertCalled: 0,
}))

vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => '1.2.3.4' }))
vi.mock('@/lib/email/send', () => ({ sendEmail: async () => true }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: table === 'utenti' ? { email: 'p@x.it' } : null, error: null })
      b.single = async () => ({ data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12' }, error: null })
      b.update = () => ({ eq: async () => ({ error: null }) })
      b.insert = () => { h.insertCalled++; return b }
      return b
    },
  }),
}))

import { POST } from '@/app/api/forms/send-otp/route'

function post(userId: string | null) {
  return new Request('http://localhost/api/forms/send-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId, data: { campo: 'x' } }),
  })
}

describe('POST /api/forms/send-otp — gate sospensione (DL-021)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.insertCalled = 0
  })

  it('genitore con figlio sospeso → 403 e NESSUNA submission creata', async () => {
    h.assertGenitore.mockResolvedValue(NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }))
    const res = await POST(post('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa14'))
    expect(res.status).toBe(403)
    expect(h.insertCalled).toBe(0)
  })

  it('genitore non sospeso → prosegue e crea la submission', async () => {
    h.assertGenitore.mockResolvedValue(null)
    const res = await POST(post('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa14'))
    expect(res.status).toBe(200)
    expect(h.insertCalled).toBe(1)
  })
})
