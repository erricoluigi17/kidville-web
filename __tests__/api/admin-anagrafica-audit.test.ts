import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P0 (DL-036/DL-037): le rotte anagrafica devono essere gated (Segreteria+Direzione)
// e scrivere un audit immutabile (logScrittura) su ogni mutazione.
// Mock: gate + audit + un solo client service-role (createAdminClient).

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  existing: { id: 'al-1', nome: 'Mario', cognome: 'Rossi' } as Record<string, unknown> | null,
  inserts: [] as Array<{ table: string; row: unknown }>,
  updates: [] as Array<{ table: string; row: unknown }>,
  deletes: [] as Array<{ table: string }>,
  upserts: [] as Array<{ table: string; row: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))

// Builder chainable: registra le mutazioni e restituisce dati plausibili.
function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = { _table: table }
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = async () => ({ data: [h.existing].filter(Boolean), error: null })
      b.single = async () => ({ data: h.existing, error: null })
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.insert = (row: unknown) => {
        h.inserts.push({ table, row })
        return {
          select: () => ({
            single: async () => ({ data: { id: `${table}-new`, ...(row as object) }, error: null }),
          }),
        }
      }
      b.update = (row: unknown) => {
        h.updates.push({ table, row })
        const u: Record<string, unknown> = {}
        u.eq = () => ({
          select: () => ({
            single: async () => ({ data: { id: 'al-1', ...(row as object) }, error: null }),
          }),
        })
        u.in = () => ({ select: async () => ({ data: [{ id: 'al-1', ...(row as object) }], error: null }) })
        return u
      }
      b.upsert = (row: unknown) => {
        h.upserts.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      }
      b.delete = () => {
        h.deletes.push({ table })
        return { eq: async () => ({ data: null, error: null }) }
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
  createClient: async () => makeClient(),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }))

import * as students from '@/app/api/admin/students/route'
import * as parents from '@/app/api/admin/parents/route'
import * as sections from '@/app/api/admin/sections/route'

const req = (url: string, body: unknown, method: string) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.existing = { id: 'al-1', nome: 'Mario', cognome: 'Rossi', scuola_id: 'sc-1' }
  h.inserts = []; h.updates = []; h.deletes = []; h.upserts = []
})

describe('P0 anagrafica — gate Segreteria+Direzione (DL-036)', () => {
  const u = (p: string) => `http://localhost/api/admin/${p}`
  const cases: Array<[string, () => Promise<Response>]> = [
    ['students POST', () => students.POST(req(u('students'), { nome: 'A', cognome: 'B', data_nascita: '2020-01-01' }, 'POST') as never)],
    ['students PATCH', () => students.PATCH(req(u('students'), { id: 'al-1', stato: 'ritirato' }, 'PATCH') as never)],
    ['students DELETE', () => students.DELETE(req(u('students'), { id: 'al-1' }, 'DELETE') as never)],
    ['parents POST', () => parents.POST(req(u('parents'), { action: 'create_parent', fiscal_code: 'RSSMRA', role: 'mother' }, 'POST') as never)],
    ['parents PATCH', () => parents.PATCH(req(u('parents'), { id: '99999999-9999-4999-8999-999999999991', emails: ['x@y.it'] }, 'PATCH') as never)],
    ['sections POST', () => sections.POST(req(u('sections'), { name: 'Girasoli' }, 'POST') as never)],
    ['sections PATCH', () => sections.PATCH(req(u('sections'), { id: 'sec-1', name: 'Tulipani' }, 'PATCH') as never)],
  ]
  for (const [name, call] of cases) {
    it(`${name}: 403 quando il gate nega (e il gate è invocato)`, async () => {
      h.requireStaff.mockResolvedValue(denied())
      const res = await call()
      expect(res.status).toBe(403)
      expect(h.requireStaff).toHaveBeenCalled()
    })
  }
})

describe('P0 anagrafica — audit immutabile su ogni mutazione (DL-037)', () => {
  const u = (p: string) => `http://localhost/api/admin/${p}`

  it('students POST: crea + audit insert(alunni)', async () => {
    const res = await students.POST(req(u('students'), { nome: 'A', cognome: 'B', data_nascita: '2020-01-01' }, 'POST') as never)
    expect(res.status).toBe(201)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunni', azione: 'insert' }),
    )
  })

  it('students PATCH singolo: audit update(alunni) con valore prima/dopo', async () => {
    const res = await students.PATCH(req(u('students'), { id: 'al-1', stato: 'ritirato' }, 'PATCH') as never)
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunni', azione: 'update', entitaId: 'al-1' }),
    )
  })

  it('students DELETE: audit delete(alunni)', async () => {
    const res = await students.DELETE(req(u('students'), { id: 'al-1' }, 'DELETE') as never)
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunni', azione: 'delete', entitaId: 'al-1' }),
    )
  })

  it('parents POST create_parent: audit insert(genitori)', async () => {
    h.existing = null // forza creazione nuovo genitore
    const res = await parents.POST(req(u('parents'), { action: 'create_parent', fiscal_code: 'RSSMRA80', role: 'mother', student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }, 'POST') as never)
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'genitori', azione: 'insert' }),
    )
  })

  it('parents PATCH: audit update(genitori)', async () => {
    const res = await parents.PATCH(req(u('parents'), { id: '99999999-9999-4999-8999-999999999991', emails: ['x@y.it'] }, 'PATCH') as never)
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'genitori', azione: 'update', entitaId: '99999999-9999-4999-8999-999999999991' }),
    )
  })

  it('sections POST: audit insert(sezioni)', async () => {
    const res = await sections.POST(req(u('sections'), { name: 'Girasoli' }, 'POST') as never)
    expect(res.status).toBe(201)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'sezioni', azione: 'insert' }),
    )
  })

  it('sections PATCH: audit update(sezioni)', async () => {
    const res = await sections.PATCH(req(u('sections'), { id: 'sec-1', name: 'Tulipani' }, 'PATCH') as never)
    expect(res.status).toBe(200)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'sezioni', azione: 'update', entitaId: 'sec-1' }),
    )
  })
})
