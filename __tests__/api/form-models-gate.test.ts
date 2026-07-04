import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ requireStaff: vi.fn() }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.insert = () => b
      b.update = () => b
      b.eq = () => b
      b.select = () => b
      b.single = async () => ({ data: { id: 'm-1' }, error: null })
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
