import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// B1 — GET /api/admin/documents-merge dumpava nome/cognome/CF/firme dell'intera
// classe SENZA gate (in GET anonima). Ora richiede requireStaff: l'anonimo non
// deve nemmeno toccare il DB (nessun dump di PII di minori).
const h = vi.hoisted(() => {
  const fromSpy = vi.fn((table: string) => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.maybeSingle = () =>
      Promise.resolve({ data: { id: 'f1', title: 'Modulo', description: '', fields: [] }, error: null })
    // alunni / forms_submissions sono awaited direttamente (thenable) → liste vuote.
    ;(qb as { then: unknown }).then = (res: (v: { data: unknown; error: null }) => unknown) =>
      res({ data: [], error: null })
    void table
    return qb
  })
  return { requireStaff: vi.fn(), fromSpy }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { GET } from '@/app/api/admin/documents-merge/route'
import { NextRequest } from 'next/server'

const req = (qs: string) => new NextRequest(`http://localhost/api/admin/documents-merge?${qs}`)
const VALID = 'form_id=11111111-1111-1111-1111-111111111111&class_name=1A'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 's1', role: 'admin', scuola_id: 'sc1' } })
})

describe('GET /api/admin/documents-merge — gate staff (B1)', () => {
  it('401 anonimo: nessun accesso al DB (nessun dump di PII di classe)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req(VALID))
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('staff autenticato: 200', async () => {
    const res = await GET(req(VALID))
    expect(res.status).toBe(200)
    expect(h.requireStaff).toHaveBeenCalled()
  })
})
