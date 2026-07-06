import { describe, it, expect, vi, beforeEach } from 'vitest'
import { STANDARD_ENROLLMENT_MODEL_ID } from '@/lib/forms/enrollment-default-schema'

// "Reimposta" del Modulo d'iscrizione standard: consentito SOLO per l'id
// standard; ripristina lo schema di base con audit.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))

function makeClient() {
  return {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { id: STANDARD_ENROLLMENT_MODEL_ID }, error: null })
      b.update = (row: Record<string, unknown>) => {
        h.updates.push(row)
        return { eq: async () => ({ data: null, error: null }) }
      }
      b.insert = async () => ({ data: null, error: null })
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import * as reset from '@/app/api/admin/form-models/reset/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/form-models/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.updates = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('POST /api/admin/form-models/reset', () => {
  it('id diverso dallo standard → 400', async () => {
    const res = await reset.POST(req({ id: 'un-altro-modello' }) as never)
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('id standard → 200 e ripristina lo schema', async () => {
    const res = await reset.POST(req({ id: STANDARD_ENROLLMENT_MODEL_ID }) as never)
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toHaveProperty('schema')
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
