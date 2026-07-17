import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// G1 — GET /api/diary/checkin esponeva orario di entrata/stato presenza per
// QUALSIASI alunno_id (IDOR). Ora passa da requireParentOfStudent: staff/docenti
// passano, il genitore solo i propri figli, l'anonimo è 401.
const h = vi.hoisted(() => {
  const fromSpy = vi.fn(() => {
    const qb: Record<string, unknown> = {}
    qb.select = () => qb
    qb.eq = () => qb
    qb.maybeSingle = () =>
      Promise.resolve({ data: { orario_entrata: '08:30', stato: 'presente' }, error: null })
    return qb
  })
  return { requireParentOfStudent: vi.fn(), fromSpy }
})

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from: h.fromSpy }),
}))

import { GET } from '@/app/api/diary/checkin/route'
import { NextRequest } from 'next/server'

const ALUNNO = '11111111-1111-1111-1111-111111111111'
const req = (qs: string) => new NextRequest(`http://localhost/api/diary/checkin?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
})

describe('GET /api/diary/checkin — gate genitore↔alunno (G1)', () => {
  it('401 anonimo: nessun accesso alle presenze', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'x' }, { status: 401 }),
    })
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('403 IDOR: genitore che chiede un figlio non suo', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(403)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200 per il genitore legittimo', async () => {
    const res = await GET(req(`alunno_id=${ALUNNO}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.orario_entrata).toBe('08:30')
    expect(h.requireParentOfStudent).toHaveBeenCalledWith(expect.anything(), ALUNNO)
  })
})
