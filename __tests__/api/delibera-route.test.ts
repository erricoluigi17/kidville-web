import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  subs: [] as { id: string; score: number }[],
  updates: [] as { id: unknown; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.then = (res: (v: unknown) => void) => res({ data: h.subs, error: null })
      b.update = (row: Record<string, unknown>) => ({
        eq: async (_col: string, val: unknown) => { h.updates.push({ id: val, row }); return { error: null } },
      })
      return b
    },
  }),
}))

import { POST } from '@/app/api/forms/delibera/route'

function post(body: unknown) {
  return new Request('http://localhost/api/forms/delibera', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/forms/delibera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.subs = []
    h.updates = []
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria' } })
  })

  it('gated allo staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', posti: 1, soglia: 0 }))).status).toBe(403)
  })

  it('400 senza modelId né submissionId', async () => {
    expect((await POST(post({}))).status).toBe(400)
  })

  it('delibera bulk: assegna ammesso/lista/non-ammesso secondo soglia+posti', async () => {
    h.subs = [{ id: 'a', score: 10 }, { id: 'b', score: 8 }, { id: 'c', score: 3 }]
    const res = await POST(post({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', posti: 1, soglia: 5 }))
    expect(res.status).toBe(200)
    const esitoById = Object.fromEntries(h.updates.map((u) => [u.id, u.row.esito_ammissione]))
    expect(esitoById).toEqual({ a: 'ammesso', b: 'lista_attesa', c: 'non_ammesso' })
    const json = await res.json()
    expect(json.data.totale).toBe(3)
    expect(json.data.conteggi.ammesso).toBe(1)
  })

  it('override singolo: aggiorna l’esito del candidato + tracciamento', async () => {
    const res = await POST(post({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', esito: 'ammesso' }))
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3')
    expect(h.updates[0].row.esito_ammissione).toBe('ammesso')
    expect(h.updates[0].row.esito_da).toBe('seg-1')
  })

  it('override con esito non valido → 400', async () => {
    expect((await POST(post({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', esito: 'boh' }))).status).toBe(400)
  })
})
