import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  model: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.model, error: null })
      b.update = (row: Record<string, unknown>) => {
        h.updates.push(row)
        return {
          eq: () => ({
            select: () => ({
              single: async () => ({ data: { ...h.model, ...row, id: 'm-1' }, error: null }),
            }),
          }),
        }
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/form-models/publish/route'

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/form-models/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria' } })
  h.model = { id: 'm-1', public_token: null, published_at: null, access_mode: 'public' }
  h.updates = []
})

describe('POST /api/admin/form-models/publish', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ id: 'm-1', action: 'publish' }))).status).toBe(403)
  })

  it('400 senza id o action', async () => {
    expect((await POST(post({ id: 'm-1' }))).status).toBe(400)
  })

  it('publish: genera token + published_at e ritorna url', async () => {
    const res = await POST(post({ id: 'm-1', action: 'publish', access_mode: 'public' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.public_token).toBeTruthy()
    expect(json.url).toBe(`/m/${json.public_token}`)
    const upd = h.updates[0]
    expect(upd.published_at).toBeTruthy()
    expect(upd.public_token).toBeTruthy()
    expect(upd.access_mode).toBe('public')
  })

  it('republish: riusa il token esistente (link stabile)', async () => {
    h.model = { id: 'm-1', public_token: 'tok-fisso', published_at: null, access_mode: 'public' }
    const res = await POST(post({ id: 'm-1', action: 'publish' }))
    const json = await res.json()
    expect(json.public_token).toBe('tok-fisso')
    expect(h.updates[0].public_token).toBe('tok-fisso')
  })

  it('unpublish: azzera published_at, preserva token', async () => {
    h.model = { id: 'm-1', public_token: 'tok-fisso', published_at: '2026-06-26T00:00:00Z', access_mode: 'public' }
    const res = await POST(post({ id: 'm-1', action: 'unpublish' }))
    expect(res.status).toBe(200)
    expect(h.updates[0].published_at).toBeNull()
    expect(h.updates[0]).not.toHaveProperty('public_token')
  })
})
