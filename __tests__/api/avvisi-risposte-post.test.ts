import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// POST /api/avvisi/[id]/risposte — presa-visione/adesione del GENITORE.
// Falle chiuse: G4 (IDOR write anonima/altrui) + morosità (adesione = azione di servizio).
//  - requireUser (mai anonimo)
//  - parent_id DALLA SESSIONE (il body è ignorato → no spoofing)
//  - genitoreHasFiglio(parent_id, student_id) (no risposte per figli altrui)
//  - assertGenitoreNonSospeso (moroso bloccato)
//  - risposta ∈ {si,no}

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const STUDENT_ID = '22222222-2222-2222-2222-222222222222'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  assertGenitoreNonSospeso: vi.fn(),
  notificaEvento: vi.fn(),
  lastUpsert: null as Record<string, unknown> | null,
  existing: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        if (table === 'avvisi_risposte') return { data: h.existing }
        if (table === 'avvisi') return { data: { author_id: 'aut-x', titolo: 'T', scuola_id: 'sc-1' } }
        if (table === 'utenti') return { data: { role: 'segreteria' } }
        return { data: null }
      }
      b.upsert = (rec: Record<string, unknown>) => {
        h.lastUpsert = rec
        return { select: () => ({ single: async () => ({ data: { id: 'r1', ...rec }, error: null }) }) }
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/avvisi/[id]/risposte/route'

const ctx = (id = AVVISO_ID) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => ({
  url: `http://test/api/avvisi/${AVVISO_ID}/risposte`,
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.lastUpsert = null
  h.existing = null
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.genitoreHasFiglio.mockResolvedValue(true)
  h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

describe('POST /api/avvisi/[id]/risposte', () => {
  it('401 quando anonimo (requireUser nega)', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await POST(req({ student_id: STUDENT_ID }), ctx())
    expect(res.status).toBe(401)
    expect(h.lastUpsert).toBeNull()
  })

  it('403 quando lo studente NON è figlio del genitore di sessione (IDOR)', async () => {
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await POST(req({ student_id: STUDENT_ID, parent_id: 'ALTRO' }), ctx())
    expect(res.status).toBe(403)
    expect(h.lastUpsert).toBeNull()
  })

  it('403 quando il genitore è sospeso per morosità', async () => {
    h.assertGenitoreNonSospeso.mockResolvedValue(NextResponse.json({ error: 'sospeso' }, { status: 403 }))
    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
    expect(res.status).toBe(403)
    expect(h.lastUpsert).toBeNull()
  })

  it('usa il parent_id dalla SESSIONE e ignora quello del body (no spoofing)', async () => {
    const res = await POST(req({ student_id: STUDENT_ID, parent_id: 'SPOOF', risposta: 'si' }), ctx())
    expect(res.status).toBe(200)
    expect(h.lastUpsert?.parent_id).toBe(PARENT_ID)
    expect(h.lastUpsert?.parent_id).not.toBe('SPOOF')
    expect(h.lastUpsert?.risposta).toBe('si')
    expect(h.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), PARENT_ID, STUDENT_ID)
  })

  it('400 quando risposta non è si/no', async () => {
    const res = await POST(req({ student_id: STUDENT_ID, risposta: 'forse' }), ctx())
    expect(res.status).toBe(400)
    expect(h.lastUpsert).toBeNull()
  })
})
