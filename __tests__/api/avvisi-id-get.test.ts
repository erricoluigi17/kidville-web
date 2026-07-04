import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// GET /api/avvisi/[id]: singolo avviso per il dettaglio cockpit /admin/avvisi/[id].
// Gate requireDocente + isolamento per plesso (assertAvvisoInScope).

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  avvisoScuola: 'sc-1' as string | null,
  avvisoRow: {
    id: '11111111-1111-1111-1111-111111111111',
    author_id: 'aut-1',
    titolo: 'Uscita al parco',
    contenuto: 'Dettagli uscita',
    tipo: 'adesione',
    target_scope: 'classe',
    target_classes: ['Girasoli'],
    scuola_id: 'sc-1',
    created_at: '2026-07-01T10:00:00Z',
  },
  author: { nome: null, cognome: null, ruolo: null, first_name: 'Anna', last_name: 'Bianchi', role: 'educator' },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...args: unknown[]) => h.scuoleDiUtente(...args) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      let sel = ''
      const b: Record<string, unknown> = {}
      b.select = (s: string) => { sel = s; return b }
      b.eq = () => b
      b.update = () => b
      b.delete = () => b
      b.single = () => b
      b.maybeSingle = async () => {
        if (table === 'avvisi' && sel === 'scuola_id') return { data: h.avvisoScuola ? { scuola_id: h.avvisoScuola } : null }
        if (table === 'avvisi') return { data: h.avvisoRow, error: null }
        if (table === 'utenti') return { data: h.author }
        return { data: null }
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/avvisi/[id]/route'

const req = (qs = '') => ({
  url: `http://test/api/avvisi/${AVVISO_ID}${qs ? `?${qs}` : ''}`,
  nextUrl: { searchParams: new URLSearchParams(qs) },
  headers: new Headers(),
}) as never

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.avvisoScuola = 'sc-1'
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
})

describe('GET /api/avvisi/[id]', () => {
  it('200 con avviso e autore mappato quando in scope', async () => {
    const res = await GET(req(), ctx(AVVISO_ID))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({
      titolo: 'Uscita al parco',
      author: { first_name: 'Anna', last_name: 'Bianchi', role: 'educator' },
    })
  })

  it('403 quando l\'avviso è di un altro plesso', async () => {
    h.avvisoScuola = 'sc-2'
    const res = await GET(req(), ctx(AVVISO_ID))
    expect(res.status).toBe(403)
  })

  it('403 quando il gate nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await GET(req(), ctx(AVVISO_ID))
    expect(res.status).toBe(403)
  })

  it('400 con id non uuid', async () => {
    const res = await GET(req(), ctx('non-uuid'))
    expect(res.status).toBe(400)
  })
})
