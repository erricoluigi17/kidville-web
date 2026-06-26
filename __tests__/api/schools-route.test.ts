import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  list: [] as Record<string, unknown>[],
  existing: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = async () => ({ data: h.list, error: null })
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'sc-new', ...row }, error: null }) }) } }
      b.update = (row: Record<string, unknown>) => { h.updates.push(row); return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'sc-1', ...row }, error: null }) }) }) } }
      return b
    },
  }),
}))

import { GET, POST, PATCH } from '@/app/api/admin/schools/route'

const req = (body: unknown, method: 'POST' | 'PATCH') =>
  new Request('http://localhost/api/admin/schools', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.list = [{ id: 'sc-1', nome: 'Kidville', attiva: true }]
  h.existing = { id: 'sc-1', nome: 'Kidville', attiva: true }
  h.inserts = []; h.updates = []
})

describe('GET /api/admin/schools', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(new Request('http://localhost/api/admin/schools'))).status).toBe(403)
  })
  it('200 lista scuole', async () => {
    const res = await GET(new Request('http://localhost/api/admin/schools'))
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1)
  })
})

describe('POST /api/admin/schools', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req({ nome: 'Sede 2' }, 'POST'))).status).toBe(403)
  })
  it('400 nome vuoto', async () => {
    expect((await POST(req({ nome: '   ' }, 'POST'))).status).toBe(400)
  })
  it('201 crea sede + audit', async () => {
    const res = await POST(req({ nome: '  Sede Nord ', citta: ' Milano ' }, 'POST'))
    expect(res.status).toBe(201)
    expect(h.inserts[0]).toMatchObject({ nome: 'Sede Nord', citta: 'Milano' })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})

describe('PATCH /api/admin/schools', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await PATCH(req({ id: 'sc-1', nome: 'X' }, 'PATCH'))).status).toBe(403)
  })
  it('400 senza id', async () => {
    expect((await PATCH(req({ nome: 'X' }, 'PATCH'))).status).toBe(400)
  })
  it('404 se la sede non esiste', async () => {
    h.existing = null
    expect((await PATCH(req({ id: 'nope', nome: 'X' }, 'PATCH'))).status).toBe(404)
  })
  it('200 rinomina/disattiva + audit', async () => {
    const res = await PATCH(req({ id: 'sc-1', nome: 'Kidville Centro', attiva: false }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.updates[0]).toMatchObject({ nome: 'Kidville Centro', attiva: false })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
