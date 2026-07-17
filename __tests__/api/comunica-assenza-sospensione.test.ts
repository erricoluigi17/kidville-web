import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// M4 — Morosità residua: il genitore SOSPESO non può comunicare un'assenza.
// La guardia va DOPO requireParentOfStudent (identità di sessione + legame
// genitore↔alunno) e blocca la SCRITTURA (upsert). Le letture restano libere.

const STUDENT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const PARENT = 'u1u1u1u1-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
  notificaEvento: vi.fn(),
  docentiDiSezione: vi.fn(),
  upsertCalled: 0,
  alunno: null as Record<string, unknown> | null,
  section: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.maybeSingle = async () => {
      if (table === 'alunni') return { data: h.alunno, error: null }
      if (table === 'sections') return { data: h.section, error: null }
      return { data: null, error: null }
    }
    b.upsert = () => {
      h.upsertCalled++
      return { select: () => ({ single: async () => ({ data: { id: 'p-1' }, error: null }) }) }
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/parent/presenze/comunica-assenza/route'

const TODAY = new Date().toISOString().slice(0, 10)
const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.notificaEvento.mockResolvedValue(undefined)
  h.docentiDiSezione.mockResolvedValue([])
  h.upsertCalled = 0
  h.alunno = { id: STUDENT, section_id: 'sec-1', scuola_id: 'sc-1' }
  h.section = { school_type: 'primaria' }
})

describe('POST /api/parent/presenze/comunica-assenza — gate sospensione morosità (M4)', () => {
  it('genitore sospeso → 403 e NESSUN upsert', async () => {
    h.assertGenitore.mockResolvedValue(
      NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }),
    )
    const res = await POST(postReq({ studentId: STUDENT, data: TODAY }))
    expect(res.status).toBe(403)
    expect(h.upsertCalled).toBe(0)
    expect(h.assertGenitore).toHaveBeenCalledWith(expect.anything(), PARENT)
  })

  it('genitore non sospeso → 201 e assenza registrata', async () => {
    h.assertGenitore.mockResolvedValue(null)
    const res = await POST(postReq({ studentId: STUDENT, data: TODAY, motivo: 'febbre' }))
    expect(res.status).toBe(201)
    expect(h.upsertCalled).toBe(1)
    expect(h.assertGenitore).toHaveBeenCalled()
  })
})
