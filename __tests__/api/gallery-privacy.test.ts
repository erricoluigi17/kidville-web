import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-041 — Privacy Lock enforced server-side su POST /api/gallery.

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = async () => ({ data: table === 'alunni' ? h.alunni : [], error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserted = row
        return { select: () => ({ single: async () => ({ data: { id: 'm1', ...row }, error: null }) }) }
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/gallery/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/gallery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.alunni = [
    { id: 'a', nome: 'Ada', cognome: 'Rossi', consenso_privacy: true },
    { id: 'b', nome: 'Bea', cognome: 'Verdi', consenso_privacy: false },
  ]
  h.inserted = null
})

describe('POST /api/gallery — Privacy Lock', () => {
  it('422 se taggo un bambino senza consenso (con nome)', async () => {
    const res = await POST(req({ file_url: 'u', tag_students: ['a', 'b'], is_broadcast: false }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.nomi).toContain('Bea Verdi')
    expect(j.ids).toContain('b')
    expect(h.inserted).toBeNull()
  })

  it('201 se tutti i taggati hanno consenso', async () => {
    const res = await POST(req({ file_url: 'u', tag_students: ['a'], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: ['a'] })
  })

  it('broadcast istituzionale bypassa il consenso → 201', async () => {
    const res = await POST(req({ file_url: 'u', tag_students: ['a', 'b'], is_broadcast: true }))
    expect(res.status).toBe(201)
  })

  it('403 se non docente', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req({ file_url: 'u' }))).status).toBe(403)
  })
})
