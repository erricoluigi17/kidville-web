import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// GET /api/admin/sections/scoped: sezioni dei plessi consentiti raggruppate per
// scuola (fonte dei selettori sede/sezione del cockpit). Scoping: educator solo
// sezioni assegnate; segreteria/coordinator il proprio plesso; admin multi-plesso.

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  sezioniDiUtente: vi.fn(),
  sections: [
    { id: 's1', name: 'Girasoli', school_type: 'infanzia', scuola_id: 'sc-1' },
    { id: 's2', name: 'Tulipani', school_type: 'nido', scuola_id: 'sc-1' },
    { id: 's3', name: '3A', school_type: 'primaria', scuola_id: 'sc-1' },
    { id: 's4', name: 'Margherite', school_type: 'infanzia', scuola_id: 'sc-2' },
  ],
  schools: [
    { id: 'sc-1', nome: 'Kidville Roma' },
    { id: 'sc-2', nome: 'Kidville Milano' },
  ],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...args: unknown[]) => h.scuoleDiUtente(...args) }))
vi.mock('@/lib/sezioni/docenti', () => ({ sezioniDiUtente: (...args: unknown[]) => h.sezioniDiUtente(...args) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const data = table === 'sections' ? h.sections : table === 'schools' ? h.schools : []
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data, error: null }),
      }
      b.select = () => b; b.in = () => b; b.order = () => b; b.eq = () => b
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/sections/scoped/route'

const req = (qs = '') => ({
  url: `http://test/api/admin/sections/scoped${qs ? `?${qs}` : ''}`,
  nextUrl: { searchParams: new URLSearchParams(qs) },
  headers: new Headers(),
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'u1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.sezioniDiUtente.mockResolvedValue([])
})

describe('GET /api/admin/sections/scoped', () => {
  it('403 quando il gate nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
  })

  it('segreteria: sezioni del proprio plesso raggruppate con nome sede', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({ scuolaId: 'sc-1', scuolaNome: 'Kidville Roma' })
    expect(j.data[0].sezioni.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3'])
    // niente lookup utenti_sezioni per i ruoli che vedono tutte le classi
    expect(h.sezioniDiUtente).not.toHaveBeenCalled()
  })

  it('admin multi-plesso: un gruppo per scuola, senza cross-contaminazione', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'adm', role: 'admin', scuola_id: 'sc-1' } })
    h.scuoleDiUtente.mockResolvedValue(['sc-1', 'sc-2'])
    const res = await GET(req())
    const j = await res.json()
    expect(j.data).toHaveLength(2)
    const roma = j.data.find((g: { scuolaId: string }) => g.scuolaId === 'sc-1')
    const milano = j.data.find((g: { scuolaId: string }) => g.scuolaId === 'sc-2')
    expect(roma.sezioni).toHaveLength(3)
    expect(milano.sezioni.map((s: { name: string }) => s.name)).toEqual(['Margherite'])
  })

  it('educator: solo le sezioni assegnate in utenti_sezioni', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
    h.sezioniDiUtente.mockResolvedValue(['s1'])
    const res = await GET(req())
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0].sezioni.map((s: { id: string }) => s.id)).toEqual(['s1'])
  })

  it('nessun plesso associato: lista vuota (non 500)', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ success: true, data: [] })
  })

  it('grado non valido: 400 dalla validazione zod', async () => {
    const res = await GET(req('grado=medie'))
    expect(res.status).toBe(400)
  })

  it('grado valido in csv: 200', async () => {
    const res = await GET(req('grado=nido,infanzia'))
    expect(res.status).toBe(200)
  })
})
