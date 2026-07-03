import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M7.4 — /api/admin/presenze/realtime: gate staff, scoping ai plessi,
// contratto { totale, sedi:[{ scuola, presenti, iscritti, classi }] }.

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
      b.eq = track('eq')
      b.limit = track('limit')
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/presenze/realtime/route'

const req = () =>
  ({ url: 'http://test/api/admin/presenze/realtime', headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.filters = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
})

describe('GET /api/admin/presenze/realtime', () => {
  it('401 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
  })

  it('totale a zero e nessuna sede senza plessi (nessuna query)', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual({
      totale: { presenti: 0, iscritti: 0, assenti: 0, appelli_mancanti: 0 },
      sedi: [],
    })
    expect(h.filters).toHaveLength(0)
  })

  it('200 con il contratto aggregato multi-sede', async () => {
    h.rows['alunni'] = [
      { id: 'al-1', section_id: 'sez-a', scuola_id: 'sc-1' },
      { id: 'al-2', section_id: 'sez-a', scuola_id: 'sc-1' },
    ]
    h.rows['presenze'] = [{ alunno_id: 'al-1', stato: 'presente' }]
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.totale).toEqual({ presenti: 1, iscritti: 2, assenti: 0, appelli_mancanti: 0 })
    expect(j.data.sedi).toHaveLength(1)
    expect(j.data.sedi[0]).toMatchObject({ scuola: 'Kidville Centro', presenti: 1, iscritti: 2 })
    expect(j.data.sedi[0].classi[0]).toMatchObject({
      classe: 'Girasoli',
      presenti: 1,
      iscritti: 2,
      appello_fatto: true,
    })
  })

  it('scopa alunni/sections/presenze/schools sui plessi dello staff', async () => {
    await GET(req())
    const inCalls = h.filters.filter((f) => f.method === 'in')
    expect(inCalls.map((f) => f.table).sort()).toEqual(['alunni', 'presenze', 'schools', 'sections'])
    expect(inCalls.find((f) => f.table === 'alunni')?.args).toEqual(['scuola_id', ['sc-1']])
    expect(inCalls.find((f) => f.table === 'presenze')?.args).toEqual(['alunni.scuola_id', ['sc-1']])
    expect(inCalls.find((f) => f.table === 'schools')?.args).toEqual(['id', ['sc-1']])
  })

  it('filtra le presenze sulla data di OGGI', async () => {
    await GET(req())
    const eqPresenze = h.filters.find((f) => f.table === 'presenze' && f.method === 'eq')
    expect(eqPresenze?.args[0]).toBe('data')
    expect(eqPresenze?.args[1]).toBe(new Date().toISOString().slice(0, 10))
  })
})
