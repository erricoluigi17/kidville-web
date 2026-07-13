import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Hardening galleria (T2b): GET mai anonima (gate identità), broadcast riservato
// alla Direzione (admin/coordinatore) anche lato server, PATCH con identità dal
// gate (il campo body `userId` è tollerato ma ignorato).

const STUDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEDIA_ID = '11111111-1111-4111-8111-111111111111'
const ALTRO_USER_ID = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  utente: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.gte = () => b
      b.lte = () => b
      b.or = () => b
      b.not = () => b
      b.range = async () => ({ data: [], count: 0, error: null })
      b.in = async () => ({ data: table === 'alunni' ? h.alunni : [], error: null })
      b.maybeSingle = async () => ({
        data:
          table === 'galleria_media_v2' ? h.media
            : table === 'utenti' ? h.utente
              : table === 'legame_genitori_alunni' ? h.legame
                : null,
        error: null,
      })
      b.insert = (row: Record<string, unknown>) => {
        h.inserted = row
        return { select: () => ({ single: async () => ({ data: { id: 'm1', ...row }, error: null }) }) }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updated = row
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'm1', ...row }, error: null }) }) }) }
      }
      return b
    },
  }),
}))

import { GET, POST, PATCH } from '@/app/api/gallery/route'

const getReq = (qs: string) => new Request(`http://localhost/api/gallery?${qs}`)
const postReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const nega401 = () => ({ response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore', scuola_id: null } })
  h.alunni = [
    { id: 'a', nome: 'Ada', cognome: 'Rossi', consenso_privacy: true },
    { id: 'b', nome: 'Bea', cognome: 'Verdi', consenso_privacy: false },
  ]
  h.inserted = null
  h.updated = null
  h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: ['a'], is_broadcast: false, scuola_id: 'sc-1' }
  h.utente = { ruolo: 'educator', scuola_id: 'sc-1' }
  h.legame = { genitore_id: 'gen1' }
})

describe('GET /api/gallery — gate identità (mai anonima)', () => {
  it('401 anonimo con studentId (gate genitore nega)', async () => {
    h.requireParentOfStudent.mockResolvedValue(nega401())
    const res = await GET(getReq(`studentId=${STUDENT_ID}`))
    expect(res.status).toBe(401)
    expect(h.requireParentOfStudent).toHaveBeenCalled()
  })

  it('401 anonimo su lista/classe (gate docente nega)', async () => {
    h.requireDocente.mockResolvedValue(nega401())
    const res = await GET(getReq('classe=A'))
    expect(res.status).toBe(401)
    expect(h.requireDocente).toHaveBeenCalled()
  })

  it('403 genitore con parentId ALTRUI (identità ≢ parentId)', async () => {
    const res = await GET(getReq(`studentId=${STUDENT_ID}&parentId=gen2`))
    expect(res.status).toBe(403)
  })

  it('200 genitore col PROPRIO parentId e legame ok', async () => {
    const res = await GET(getReq(`studentId=${STUDENT_ID}&parentId=gen1`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ media: [], total: 0 })
  })
})

describe('POST /api/gallery — broadcast riservato alla Direzione', () => {
  it('403 se un educator tenta is_broadcast=true (niente insert)', async () => {
    const res = await POST(postReq({ file_url: 'u', is_broadcast: true, target_classes: ['A'] }))
    expect(res.status).toBe(403)
    expect(h.inserted).toBeNull()
  })

  it('201 se la Direzione (coordinator) pubblica in broadcast', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'co1', role: 'coordinator', scuola_id: 'sc-1' } })
    const res = await POST(postReq({ file_url: 'u', is_broadcast: true, target_classes: ['A'] }))
    expect(res.status).toBe(201)
  })
})

describe('PATCH /api/gallery — broadcast Direzione + identità dal gate', () => {
  it('403 se un educator flippa is_broadcast=true su una foto privata (niente update)', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, is_broadcast: true }))
    expect(res.status).toBe(403)
    expect(h.updated).toBeNull()
  })

  it('usa l\'identità del gate: il body userId ALTRUI è ignorato → 200', async () => {
    // Gate = ed1 (proprietario del media): se il codice usasse il body userId
    // (altro utente, non proprietario) l'autorizzazione educator fallirebbe.
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: ALTRO_USER_ID, tag_students: ['a'] }))
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ tag_students: ['a'] })
  })

  it('accetta il body SENZA userId (identità solo dal gate) → 200', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, caption: 'gita' }))
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ caption: 'gita' })
  })

  it('401 se il gate nega (anonimo)', async () => {
    h.requireDocente.mockResolvedValue(nega401())
    const res = await PATCH(patchReq({ id: MEDIA_ID, caption: 'x' }))
    expect(res.status).toBe(401)
    expect(h.updated).toBeNull()
  })
})
