import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  emetti: vi.fn(),
  update: vi.fn(() => ({ eq: async () => ({ error: null }) })),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: () => ({ update: h.update }) }),
}))
vi.mock('@/lib/aruba/emissione', () => ({ emettiFatturaPagamento: h.emetti }))

import { POST } from '@/app/api/pagamenti/fattura/route'

function post(body: unknown) {
  return new Request('http://localhost/api/pagamenti/fattura', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/pagamenti/fattura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('blocca i non-staff (gate requireStaff)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await POST(post({ pagamento_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }))
    expect(res.status).toBe(403)
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('400 senza pagamento_id', async () => {
    const res = await POST(post({}))
    expect(res.status).toBe(400)
  })

  it('mappa esito non_configurato → 503', async () => {
    h.emetti.mockResolvedValue({ ok: false, motivo: 'non_configurato', messaggio: 'Aruba non configurata', httpStatus: 503 })
    const res = await POST(post({ pagamento_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }))
    expect(res.status).toBe(503)
  })

  it('esito ok → 200 con numero e id', async () => {
    h.emetti.mockResolvedValue({ ok: true, fatturaStato: 'in_attesa', uploadFileName: 'ITxx_a.xml.p7m', numero: 7 })
    const res = await POST(post({ pagamento_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.numero).toBe(7)
  })
})
