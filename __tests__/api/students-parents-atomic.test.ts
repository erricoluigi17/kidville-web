import { describe, it, expect, vi, beforeEach } from 'vitest'

// Salvataggio ATOMICO alunno+genitori: POST /api/admin/students con `parents[]`
// crea l'alunno, poi crea/collega ogni genitore e riporta l'esito per-genitore.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: null, error: null }) // nessun genitore esistente
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return { select: () => ({ single: async () => ({ data: { id: `${table}-new`, ...row }, error: null }) }) }
      }
      b.upsert = (row: Record<string, unknown>) => {
        h.upserts.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import * as students from '@/app/api/admin/students/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []; h.upserts = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('POST /api/admin/students con parents[]', () => {
  it('crea alunno + genitore e restituisce l\'esito per-genitore', async () => {
    const res = await students.POST(req({
      nome: 'Marco', cognome: 'Rossi', data_nascita: '2020-01-01',
      parents: [{ first_name: 'Anna', last_name: 'Rossi', role: 'mother', fiscal_code: '' }],
    }) as never)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(Array.isArray(json.parents)).toBe(true)
    expect(json.parents).toHaveLength(1)
    expect(json.parents[0].ok).toBe(true)
    // alunno + genitore inseriti, legame creato
    expect(h.inserts.some(i => i.table === 'alunni')).toBe(true)
    expect(h.inserts.some(i => i.table === 'parents')).toBe(true)
    expect(h.upserts.some(u => u.table === 'student_parents')).toBe(true)
  })

  it('senza parents[]: crea solo l\'alunno (retro-compatibile)', async () => {
    const res = await students.POST(req({ nome: 'A', cognome: 'B', data_nascita: '2020-01-01' }) as never)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.parents).toEqual([])
    expect(h.inserts.some(i => i.table === 'parents')).toBe(false)
  })
})
