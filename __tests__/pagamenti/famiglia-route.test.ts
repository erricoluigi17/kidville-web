import { it, expect, vi, beforeEach, describe } from 'vitest'

// GET /api/pagamenti/famiglia?parent_id= — dati per la transazione unica (slice S4).
//  figli via unione legami; voci aperte con residuo effettivo ordinate per scadenza
//  ASC (più vecchie prima); saldo credito famiglia; saldo ticket per figlio;
//  degradazione: colonna sconto assente (42703) → retry senza; genitore senza figli.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  figli: vi.fn(),
  saldo: vi.fn(),
  parent: { id: '33333333-3333-4333-8333-333333333333', first_name: 'Anna', last_name: 'Rossi', auth_user_id: 'acc-1' } as Record<string, unknown> | null,
  studentParents: [] as unknown[],
  alunni: [] as unknown[],
  ticket: [] as unknown[],
  pagamenti: { data: [] as unknown, error: null as { code?: string } | null },
  pagamentiRetry: { data: [] as unknown, error: null as { code?: string } | null },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.figli(...a) }))
vi.mock('@/lib/pagamenti/credito', () => ({ saldoCredito: (...a: unknown[]) => h.saldo(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let sconto = true
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { sconto = typeof cols === 'string' ? cols.includes('sconto') : true; return b }
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.maybeSingle = async () => (table === 'parents' ? { data: h.parent, error: null } : { data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'student_parents') return resolve({ data: h.studentParents, error: null })
        if (table === 'alunni') return resolve({ data: h.alunni, error: null })
        if (table === 'ticket_mensa') return resolve({ data: h.ticket, error: null })
        if (table === 'pagamenti') return resolve(sconto ? h.pagamenti : h.pagamentiRetry)
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/famiglia/route'

const SC = '22222222-2222-4222-8222-222222222222'
const AL1 = '55555555-5555-4555-8555-555555555555'
const AL2 = '66666666-6666-4666-8666-666666666666'
const get = (qs: string) => new Request(`http://localhost/api/pagamenti/famiglia?${qs}`, { headers: { 'x-user-id': 'seg-1' } }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.figli.mockResolvedValue([AL1, AL2])
  h.saldo.mockResolvedValue(25)
  h.parent = { id: '33333333-3333-4333-8333-333333333333', first_name: 'Anna', last_name: 'Rossi', auth_user_id: 'acc-1' }
  h.studentParents = [{ student_id: AL1 }, { student_id: AL2 }]
  h.alunni = [
    { id: AL1, nome: 'Uno', cognome: 'Rossi', scuola_id: SC },
    { id: AL2, nome: 'Due', cognome: 'Rossi', scuola_id: SC },
  ]
  h.ticket = [{ alunno_id: AL1, saldo_ticket: 8 }]
  // due voci aperte con scadenze diverse: la più vecchia deve venire prima
  h.pagamenti = {
    data: [
      { id: 'p-new', alunno_id: AL1, descrizione: 'Retta luglio', importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-07-10', stato: 'da_pagare', tipo: 'singolo' },
      { id: 'p-old', alunno_id: AL2, descrizione: 'Retta giugno', importo: 100, importo_pagato: 20, sconto: 0, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' },
      { id: 'p-paid', alunno_id: AL1, descrizione: 'Saldata', importo: 50, importo_pagato: 50, sconto: 0, scadenza: '2026-05-10', stato: 'pagato', tipo: 'singolo' },
    ],
    error: null,
  }
  h.pagamentiRetry = { data: [], error: null }
})

describe('GET famiglia', () => {
  it('ritorna figli, saldo ticket, credito e voci aperte ordinate per scadenza ASC', async () => {
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.credito).toBe(25)
    expect(j.data.figli).toHaveLength(2)
    const al1 = j.data.figli.find((f: { id: string }) => f.id === AL1)
    expect(al1.saldo_ticket).toBe(8)
    // solo le voci con residuo > 0 (la saldata esclusa), ordinate più vecchie prima
    expect(j.data.voci.map((v: { id: string }) => v.id)).toEqual(['p-old', 'p-new'])
    const old = j.data.voci[0]
    expect(old.residuo).toBe(80)
  })

  it('colonna sconto assente (42703) → retry senza sconto, non 500', async () => {
    h.pagamenti = { data: null, error: { code: '42703' } }
    h.pagamentiRetry = {
      data: [{ id: 'p-old', alunno_id: AL2, descrizione: 'Retta giugno', importo: 100, importo_pagato: 20, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' }],
      error: null,
    }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.voci).toHaveLength(1)
    expect(j.data.voci[0].residuo).toBe(80)
  })

  it('parent_id mancante → 400', async () => {
    const res = await GET(get(''))
    expect(res.status).toBe(400)
  })

  it('genitore inesistente → 404', async () => {
    h.parent = null
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(404)
  })

  it('genitore senza figli → data vuota ma credito presente', async () => {
    h.studentParents = []
    h.figli.mockResolvedValue([])
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    const j = await res.json()
    expect(j.data.figli).toEqual([])
    expect(j.data.voci).toEqual([])
    expect(j.data.credito).toBe(25)
  })
})
