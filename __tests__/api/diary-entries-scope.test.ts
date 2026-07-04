import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-040 (S9b): il ramo genitore di GET /api/diary/entries legge eventi_diario
// via SERVICE-ROLE (così le policy permissive anon sono droppate senza rompere la
// lettura). Lo scoping di proprietà è rinviato a S13 (vedi commento nella route).
// Il ramo docente resta gated (requireDocente).

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  events: [{ id: 'e1', tipo_evento: 'pranzo', orario_inizio: '2026-06-27T12:00:00Z', dettagli: {}, nota_libera: 'buona giornata' }],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null, scuoleDiUtente: async () => ['sc-1'] }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(), enqueueDiarioGenitori: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from() {
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: h.events, error: null }),
      }
      b.select = () => b; b.eq = () => b; b.gte = () => b; b.lte = () => b; b.in = () => b; b.order = () => b
      return b
    },
  }),
}))

import { GET } from '@/app/api/diary/entries/route'

// url richiesta da parseQuery (M3); alunno_id GUID-shaped per zUuid
const req = (qs: string) => ({ url: `http://test/api/diary/entries?${qs}`, nextUrl: { searchParams: new URLSearchParams(qs) }, headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
})

describe('GET /api/diary/entries', () => {
  it('ramo genitore: 200 con eventi mappati (service-role, nota inclusa)', async () => {
    const res = await GET(req('alunno_id=11111111-1111-1111-1111-111111111111&from=2026-06-27&to=2026-06-27'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Array.isArray(j)).toBe(true)
    expect(j[0]).toMatchObject({ tipo_evento: 'pranzo', note: 'buona giornata' })
  })

  it('ramo docente: 403 quando il gate nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await GET(req('sezione=Girasoli&date=2026-06-27'))
    expect(res.status).toBe(403)
    expect(h.requireDocente).toHaveBeenCalled()
  })
})
