import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P0 (DL-035): /api/me restituisce SOLO il profilo dell'utente corrente
// (gated, service-role server-side), senza segreti — sostituisce le letture
// anon dirette di `utenti` (gallery docente, modulistica genitore).

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  row: { id: 'u-1', nome: 'Anna', cognome: 'Verdi', ruolo: 'educator', password_segreta: 'SECRET', email: 'a@b.it' } as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.row, error: null })
      b.single = async () => ({ data: h.row, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/me/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'u-1', role: 'educator' } })
  h.row = { id: 'u-1', nome: 'Anna', cognome: 'Verdi', ruolo: 'educator', password_segreta: 'SECRET', email: 'a@b.it' }
})

describe('GET /api/me', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(401)
  })

  it('200 ritorna il profilo con ruolo', async () => {
    const res = await GET(new Request('http://localhost/api/me'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ruolo ?? j.role).toBeTruthy()
    expect(j.nome).toBe('Anna')
  })

  it('non espone password_segreta', async () => {
    const res = await GET(new Request('http://localhost/api/me'))
    const j = await res.json()
    expect(j.password_segreta).toBeUndefined()
  })
})
