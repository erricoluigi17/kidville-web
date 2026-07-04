import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  legami: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.or = () => b
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'legame_genitori_alunni' ? h.legami : table === 'parents' ? h.parents : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/tutori/route'

const AID = '11111111-1111-4111-8111-111111111111'
const url = () => new Request(`http://localhost/api/pagamenti/tutori?alunno_id=${AID}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria' } })
  h.legami = [
    { genitore_id: 'u-mamma', percentuale_pagamento: 50, intestatario_fattura: true, utenti: { id: 'u-mamma', nome: 'Giulia', cognome: 'Farina', email: 'g@x.it' } },
    { genitore_id: 'u-papa', percentuale_pagamento: 50, intestatario_fattura: false, utenti: { id: 'u-papa', nome: 'Marco', cognome: 'Rossi', email: 'm@x.it' } },
  ]
  h.parents = [
    { id: 'p1', auth_user_id: 'u-mamma', fiscal_code: 'FRNGLI80A41H501Z' },
    { id: 'p2', auth_user_id: 'u-papa', fiscal_code: null },
  ]
})

describe('GET /api/pagamenti/tutori', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(url())).status).toBe(403)
  })

  it('400 senza alunno_id', async () => {
    expect((await GET(new Request('http://localhost/api/pagamenti/tutori'))).status).toBe(400)
  })

  it('has_fiscal_code via ponte parents.auth_user_id', async () => {
    const res = await GET(url())
    expect(res.status).toBe(200)
    const j = await res.json()
    const mamma = j.data.find((t: { adult_id: string }) => t.adult_id === 'u-mamma')
    const papa = j.data.find((t: { adult_id: string }) => t.adult_id === 'u-papa')
    expect(mamma.has_fiscal_code).toBe(true)
    expect(papa.has_fiscal_code).toBe(false)
    // contratto storico preservato
    expect(mamma).toMatchObject({ nome: 'Giulia', cognome: 'Farina', intestatario: true })
  })
})
