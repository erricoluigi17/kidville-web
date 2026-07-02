import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P0 (DL-035): le viste admin form (graduatorie/compilazioni) leggono via route
// server gated (requireStaff), non più dal client anon. La modifica punteggio è
// auditata.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  rows: [{ id: '51515151-5151-4515-8515-515151515151', model_id: 'm-1', score: 10, status: 'completed', manual_adjustments: [] }] as Record<string, unknown>[],
  models: [{ id: 'm-1', title: 'Iscrizione' }] as Record<string, unknown>[],
  updates: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const result = table === 'form_models' ? h.models : h.rows
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: result, error: null }),
      }
      b.select = () => b
      b.eq = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.maybeSingle = async () => ({ data: result[0] ?? null, error: null })
      b.single = async () => ({ data: result[0] ?? null, error: null })
      b.update = (row: unknown) => {
        h.updates.push(row)
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: '51515151-5151-4515-8515-515151515151', ...(row as object) }, error: null }) }) }) }
      }
      return b
    },
  }),
}))

import { GET as modelsGET } from '@/app/api/admin/forms/models/route'
import { GET as rankingsGET } from '@/app/api/admin/forms/rankings/route'
import { GET as submissionsGET } from '@/app/api/admin/forms/submissions/route'
import { PATCH as submissionPATCH } from '@/app/api/admin/forms/submissions/[id]/route'

const denied = () => ({ response: NextResponse.json({}, { status: 403 }) }) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.rows = [{ id: '51515151-5151-4515-8515-515151515151', model_id: 'm-1', score: 10, status: 'completed', manual_adjustments: [] }]
  h.models = [{ id: 'm-1', title: 'Iscrizione' }]
  h.updates = []
})

describe('GET /api/admin/forms/models', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue(denied())
    expect((await modelsGET(new Request('http://localhost/x'))).status).toBe(403)
  })
  it('200 lista modelli', async () => {
    const res = await modelsGET(new Request('http://localhost/x'))
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1)
  })
})

describe('GET /api/admin/forms/rankings', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue(denied())
    expect((await rankingsGET(new Request('http://localhost/x'))).status).toBe(403)
  })
  it('200 graduatoria', async () => {
    const res = await rankingsGET(new Request('http://localhost/x?modelId=m-1'))
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })
})

describe('GET /api/admin/forms/submissions', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue(denied())
    expect((await submissionsGET(new Request('http://localhost/x'))).status).toBe(403)
  })
  it('200 compilazioni', async () => {
    const res = await submissionsGET(new Request('http://localhost/x?status=completed'))
    expect(res.status).toBe(200)
  })
})

describe('PATCH /api/admin/forms/submissions/[id]', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await submissionPATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: '{}' }),
      ctx('51515151-5151-4515-8515-515151515151'),
    )
    expect(res.status).toBe(403)
  })
  it('200 aggiorna manual_adjustments + audit', async () => {
    const body = { manual_adjustments: [{ delta: 2, reason: 'fratello', at: '2026-01-01' }] }
    const res = await submissionPATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }),
      ctx('51515151-5151-4515-8515-515151515151'),
    )
    expect(res.status).toBe(200)
    expect(h.updates[0]).toMatchObject({ manual_adjustments: body.manual_adjustments })
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'graduatoria', azione: 'update', entitaId: '51515151-5151-4515-8515-515151515151' }),
    )
  })
})
