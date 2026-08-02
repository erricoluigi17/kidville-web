import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ requireStaff: vi.fn() }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // Fixture SENZA sedi: qui si prova il gate di RUOLO, non l'isolamento fra
    // sedi (che sta in `modulistica-mutazioni-scope-sede.test.ts`, dove il finto
    // client filtra davvero). Con zero sedi reali non c'è niente da isolare e il
    // gate di tenant della PATCH lascia passare — è la stessa condizione del DB
    // E2E della CI.
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      b.insert = () => b
      b.update = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.select = () => b
      b.single = async () => ({ data: { id: 'm-1' }, error: null })
      // Il modello esiste e non ha sede (colonna assente, come sul DB E2E).
      b.maybeSingle = async () => ({
        data: tabella === 'form_models' ? { id: 'm-1' } : null,
        error: null,
      })
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok)
      return b
    },
  }),
}))

import { POST, PATCH } from '@/app/api/admin/form-models/route'

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/form-models', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const patch = (body: unknown) =>
  new Request('http://localhost/api/admin/form-models', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria' } })
})

describe('gate /api/admin/form-models', () => {
  it('POST 403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ title: 'X', schema: {} }))).status).toBe(403)
  })

  it('POST 201 con staff', async () => {
    expect((await POST(post({ title: 'X', schema: { pages: [] } }))).status).toBe(201)
  })

  it('PATCH 403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await PATCH(patch({ id: 'm-1', title: 'Y' }))).status).toBe(403)
  })

  it('PATCH 200 con staff', async () => {
    expect((await PATCH(patch({ id: 'm-1', title: 'Y' }))).status).toBe(200)
  })
})
