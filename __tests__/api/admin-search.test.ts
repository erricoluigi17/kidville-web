import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M7.1 — /api/admin/search: gate staff, validazione q (min 2 char),
// shape { id, label, sub, href } per gruppo, scoping ai plessi.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; method: string; args: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const rows = () => h.rows[table] ?? []
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows(), error: null }),
      }
      const track = (method: string) => (...args: unknown[]) => {
        h.filters.push({ table, method, args })
        return b
      }
      b.select = track('select')
      b.in = track('in')
      b.or = track('or')
      b.ilike = track('ilike')
      b.limit = track('limit')
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/search/route'

const req = (qs: string) =>
  ({ url: `http://test/api/admin/search${qs ? `?${qs}` : ''}`, headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.filters = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
})

describe('GET /api/admin/search', () => {
  it('401 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req('q=ross'))).status).toBe(401)
  })

  it('400 senza q (schema zod)', async () => {
    expect((await GET(req(''))).status).toBe(400)
  })

  it('400 con q di 1 carattere (schema zod)', async () => {
    expect((await GET(req('q=r'))).status).toBe(400)
  })

  it('gruppi vuoti senza query se lo staff non ha plessi', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await GET(req('q=ross'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual({ alunni: [], utenti: [], sezioni: [], moduli: [] })
    expect(h.filters).toHaveLength(0)
  })

  it('200 con shape { id, label, sub, href } per ogni gruppo', async () => {
    h.rows['alunni'] = [{ id: 'al-1', nome: 'Rosa', cognome: 'Rossi', classe_sezione: 'Girasoli' }]
    h.rows['utenti'] = [{ id: 'ut-1', nome: 'Remo', cognome: 'Rossini', role: 'educator', ruolo: null }]
    h.rows['sections'] = [{ id: 'sez-1', name: 'Rose', school_type: 'infanzia' }]
    h.rows['form_models'] = [{ id: 'fm-1', title: 'Rientro anticipato', is_active: true }]
    const res = await GET(req('q=ros'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.alunni).toEqual([
      { id: 'al-1', label: 'Rosa Rossi', sub: 'Girasoli', href: '/admin/students' },
    ])
    expect(j.data.utenti).toEqual([
      { id: 'ut-1', label: 'Remo Rossini', sub: 'Docente', href: '/admin/staff' },
    ])
    expect(j.data.sezioni).toEqual([
      { id: 'sez-1', label: 'Rose', sub: 'infanzia', href: '/admin/students' },
    ])
    expect(j.data.moduli).toEqual([
      { id: 'fm-1', label: 'Rientro anticipato', sub: 'Attivo', href: '/admin/modulistica' },
    ])
  })

  it('scopa alunni/utenti/sezioni sui plessi dello staff (moduli globali)', async () => {
    await GET(req('q=ros'))
    const inCalls = h.filters.filter((f) => f.method === 'in')
    expect(inCalls.map((f) => f.table).sort()).toEqual(['alunni', 'sections', 'utenti'])
    for (const f of inCalls) expect(f.args).toEqual(['scuola_id', ['sc-1']])
  })

  it('filtra gli utenti come staff su ENTRAMBE le colonne role/ruolo', async () => {
    await GET(req('q=ros'))
    const orUtenti = h.filters.filter((f) => f.table === 'utenti' && f.method === 'or')
    expect(orUtenti.some((f) => String(f.args[0]).includes('role.in.') && String(f.args[0]).includes('ruolo.in.'))).toBe(true)
  })

  it('sanifica i metacaratteri ilike/or dal termine di ricerca', async () => {
    await GET(req(`q=${encodeURIComponent('ro,ss(i%_)')}`))
    const orAlunni = h.filters.find((f) => f.table === 'alunni' && f.method === 'or')
    expect(String(orAlunni?.args[0])).toContain('nome.ilike.%ro ss i%')
  })

  it('gruppi vuoti se il termine sanificato resta sotto i 2 caratteri', async () => {
    const res = await GET(req(`q=${encodeURIComponent('%%')}`))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ alunni: [], utenti: [], sezioni: [], moduli: [] })
    expect(h.filters).toHaveLength(0)
  })
})
