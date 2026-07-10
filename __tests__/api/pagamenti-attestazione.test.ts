import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  pagamenti: [] as Record<string, unknown>[],
  incassi: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? h.alunno : table === 'legame_genitori_alunni' ? h.legame : table === 'admin_settings' ? {} : table === 'parents' ? null : null,
        error: null,
      })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'pagamenti' ? h.pagamenti : table === 'incassi' ? h.incassi : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/attestazione/route'

const AID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'
const req = (qs: string) => new Request(`http://localhost/api/pagamenti/attestazione?${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.alunno = { id: AID, nome: 'Mario', cognome: 'Rossi', scuola_id: 'sc-1', intestatario_fatture: null }
  h.legame = { alunno_id: AID }
  h.pagamenti = [{ id: 'p1', descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta', nome: 'Retta' } }]
  h.incassi = [{ pagamento_id: 'p1', importo: 150, metodo: 'bonifico', data_incasso: '2026-01-10' }]
})

describe('GET /api/pagamenti/attestazione', () => {
  it('staff: 200 PDF', async () => {
    const res = await GET(req(`alunno_id=${AID}&anno=2026`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('genitore del bambino: 200; senza legame: 403', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g-1', role: 'genitore' } })
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(200)
    h.legame = null
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(403)
  })

  it('400 senza anno o alunno', async () => {
    expect((await GET(req(`alunno_id=${AID}`))).status).toBe(400)
    expect((await GET(req('anno=2026'))).status).toBe(400)
  })

  it('404 alunno inesistente', async () => {
    h.alunno = null
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(404)
  })
})
