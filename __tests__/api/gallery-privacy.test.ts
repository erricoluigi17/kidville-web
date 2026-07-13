import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-041 — Privacy Lock (Galleria) enforced server-side su POST e PATCH.
// Regola "foto privata": un solo bambino taggato è sempre pubblicabile (foto
// visibile solo ai suoi genitori); le foto di gruppo (≥2 taggati) richiedono la
// liberatoria (consenso_privacy === true) per OGNI bambino. Broadcast bypassa.

const MSG_GRUPPO =
  'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).'

const MEDIA_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  utente: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.or = () => b
      b.range = () => b
      b.not = () => b
      b.in = async () => ({ data: table === 'alunni' ? h.alunni : [], error: null })
      b.maybeSingle = async () => ({
        data: table === 'galleria_media_v2' ? h.media : table === 'utenti' ? h.utente : null,
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

import { POST, PATCH } from '@/app/api/gallery/route'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.alunni = [
    { id: 'a', nome: 'Ada', cognome: 'Rossi', consenso_privacy: true },
    { id: 'b', nome: 'Bea', cognome: 'Verdi', consenso_privacy: false },
  ]
  h.inserted = null
  h.updated = null
  // PATCH: media esistente dell'educatore (uploaded_by === userId → autorizzato),
  // e l'utente è admin per by-passare la logica di intersezione classi.
  h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: ['a'], is_broadcast: false, scuola_id: 'sc-1' }
  h.utente = { ruolo: 'admin', scuola_id: 'sc-1' }
})

describe('POST /api/gallery — Privacy Lock', () => {
  it('422 sulla foto di GRUPPO se un taggato è senza liberatoria (messaggio + nomi/ids)', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['a', 'b'], is_broadcast: false }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.nomi).toContain('Bea Verdi')
    expect(j.ids).toContain('b')
    expect(h.inserted).toBeNull()
  })

  it('201 foto PRIVATA: singolo taggato SENZA liberatoria è pubblicabile', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['b'], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: ['b'] })
  })

  it('201 se tutti i taggati hanno consenso', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['a'], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: ['a'] })
  })

  it('broadcast istituzionale bypassa il consenso → 201', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['a', 'b'], is_broadcast: true }))
    expect(res.status).toBe(201)
  })

  it('403 se non docente', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(postReq({ file_url: 'u' }))).status).toBe(403)
  })
})

describe('PATCH /api/gallery — Privacy Lock su modifica tag', () => {
  it('OK se i tag effettivi restano un singolo bambino (foto privata)', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, tag_students: ['b'] }))
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ tag_students: ['b'] })
  })

  it('422 se aggiungo un secondo bambino e uno è senza liberatoria', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, tag_students: ['a', 'b'] }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.nomi).toContain('Bea Verdi')
    expect(j.ids).toContain('b')
    expect(h.updated).toBeNull()
  })
})
