import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  alunni: [] as Record<string, unknown>[],
  links: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.neq = () => b
      b.in = () => b
      b.order = () => b
      b.then = (res: (v: unknown) => unknown) => {
        const data = table === 'alunni' ? h.alunni : table === 'student_parents' ? h.links : table === 'parents' ? h.parents : []
        return Promise.resolve({ data, error: null }).then(res)
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/gdpr/candidates/route'

const get = () => new Request('http://localhost/api/admin/gdpr/candidates')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin' } })
  h.alunni = [{ id: 'al-1', nome: 'Marco', cognome: 'Rossi', classe_sezione: 'A', stato: 'non_iscritto' }]
  h.links = [{ student_id: 'al-1', parent_id: 'p-1' }]
  h.parents = [{ id: 'p-1', first_name: 'Maria', last_name: 'Rossi' }]
})

describe('GET /api/admin/gdpr/candidates', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(get())).status).toBe(403)
  })

  it('200 lista candidati con i genitori collegati', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe('al-1')
    expect(json[0].genitori).toEqual([{ id: 'p-1', nome: 'Maria Rossi' }])
  })
})
