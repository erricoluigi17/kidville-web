import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-043 — icona pericolo allergeni lato genitore: il menu del giorno è
// incrociato con gli allergeni del figlio (riusa gli helper puri già testati).

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  alunno: { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', nome: 'Mia', scuola_id: 'sc-1', allergies: null, allergeni: ['glutine'] } as Record<string, unknown> | null,
  menu: { attivo: true, chiuso: false, allergeni: { primo: ['glutine', 'latte'], secondo: ['uova'] } } as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/mensa/server', () => ({ loadResolveOptions: async () => ({}), DEFAULT_SCUOLA: 'sc-def' }))
vi.mock('@/lib/mensa/resolveMenu', () => ({ resolveMenuGiorno: () => h.menu }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b; b.eq = () => b
      b.maybeSingle = async () => ({ data: h.alunno, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/parent/mensa/allergie/route'

const req = (qs: string) => new Request(`http://localhost/api/parent/mensa/allergie?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
  h.alunno = { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', nome: 'Mia', scuola_id: 'sc-1', allergies: null, allergeni: ['glutine'] }
  h.menu = { attivo: true, chiuso: false, allergeni: { primo: ['glutine', 'latte'], secondo: ['uova'] } }
})

describe('GET /api/parent/mensa/allergie', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req('alunno_id=a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1&date=2026-06-29'))).status).toBe(401)
  })

  it('400 senza alunno_id', async () => {
    expect((await GET(req('date=2026-06-29'))).status).toBe(400)
  })

  it('pericolo=true con conflitto glutine', async () => {
    const res = await GET(req('alunno_id=a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1&date=2026-06-29'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.pericolo).toBe(true)
    expect(j.conflitti).toContain('glutine')
  })

  it('pericolo=false se il figlio non ha allergeni', async () => {
    h.alunno = { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', nome: 'Mia', scuola_id: 'sc-1', allergies: null, allergeni: [] }
    const res = await GET(req('alunno_id=a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1&date=2026-06-29'))
    const j = await res.json()
    expect(j.pericolo).toBe(false)
    expect(j.conflitti).toEqual([])
  })

  it('pericolo=false se la mensa è chiusa quel giorno', async () => {
    h.menu = { attivo: false, chiuso: true, allergeni: null }
    const res = await GET(req('alunno_id=a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1&date=2026-06-29'))
    const j = await res.json()
    expect(j.pericolo).toBe(false)
  })
})
