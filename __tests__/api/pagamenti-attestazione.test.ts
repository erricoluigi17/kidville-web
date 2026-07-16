import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  pagamenti: [] as Record<string, unknown>[],
  incassi: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => ['sc-1'] }))
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
        data: table === 'alunni' ? h.alunno : table === 'admin_settings' ? {} : table === 'parents' ? null : null,
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
  // Default: staff (segreteria) autenticato → il gate concede.
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.alunno = { id: AID, nome: 'Mario', cognome: 'Rossi', scuola_id: 'sc-1', intestatario_fatture: null }
  h.pagamenti = [{ id: 'p1', descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta', nome: 'Retta' } }]
  h.incassi = [{ pagamento_id: 'p1', importo: 150, metodo: 'bonifico', data_incasso: '2026-01-10' }]
})

describe('GET /api/pagamenti/attestazione', () => {
  it('staff: 200 PDF', async () => {
    const res = await GET(req(`alunno_id=${AID}&anno=2026`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('genitore autenticato: 403 (attestazione solo lato segreteria)', async () => {
    // requireStaff nega al genitore prima ancora di entrare nel corpo della route.
    h.requireStaff.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato: operazione riservata allo staff' }, { status: 403 }),
    })
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(403)
  })

  it('non autenticato: 401', async () => {
    h.requireStaff.mockResolvedValue({
      response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
    })
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(401)
  })

  it('400 senza anno o alunno', async () => {
    expect((await GET(req(`alunno_id=${AID}`))).status).toBe(400)
    expect((await GET(req('anno=2026'))).status).toBe(400)
  })

  it('404 alunno inesistente', async () => {
    h.alunno = null
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(404)
  })

  it('staff: alunno di un\'altra sede → 404 (scoping)', async () => {
    h.alunno = { ...h.alunno!, scuola_id: 'sc-ALTRA' }
    expect((await GET(req(`alunno_id=${AID}&anno=2026`))).status).toBe(404)
  })
})
