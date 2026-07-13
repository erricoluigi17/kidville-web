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
  logEvento: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  utente: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
// Appendice logging: si spia SOLO logEvento (il resto del logger resta reale e
// silenzioso sotto VITEST). Gli eventi di dominio della galleria hanno `evento`
// = 'galleria'; quelli di `withRoute` hanno 'route' e vanno filtrati via.
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
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

// Solo gli eventi di dominio della galleria (via il rumore di `route` di withRoute).
const eventiGalleria = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.alunni = [
    { id: 'a', nome: 'Ada', cognome: 'Rossi', consenso_privacy: true },
    { id: 'b', nome: 'Bea', cognome: 'Verdi', consenso_privacy: false },
  ]
  h.inserted = null
  h.updated = null
  // PATCH: l'identità è quella del gate ('ed1') e il media è suo → autorizzato
  // dal ramo educator-proprietario (uploaded_by === identità del gate). Il
  // body `userId` è tollerato per retro-compatibilità ma ignorato.
  h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: ['a'], is_broadcast: false, scuola_id: 'sc-1' }
  h.utente = { ruolo: 'educator', scuola_id: 'sc-1' }
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
    // Appendice logging: SOLO conteggi nel log, MAI nomi/id dei bambini.
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:POST', esito: 'liberatoria-mancante', taggati: 2, senzaConsenso: 1 })
    // privacy: nessun nome/id nel payload del log
    expect(JSON.stringify(ev[0][2])).not.toContain('Bea')
    expect(Object.keys(ev[0][2] as object)).not.toContain('nomi')
    expect(Object.keys(ev[0][2] as object)).not.toContain('ids')
  })

  it('201 foto PRIVATA: singolo taggato SENZA liberatoria è pubblicabile', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['b'], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: ['b'] })
    // Appendice logging: l'evento critico logga anche il SUCCESSO (conteggi/flag).
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:POST', esito: 'pubblicata', nTag: 1, broadcast: false })
  })

  it('201 se tutti i taggati hanno consenso', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: ['a'], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: ['a'] })
  })

  it('broadcast istituzionale (Direzione) bypassa il consenso → 201', async () => {
    // Il broadcast è riservato alla Direzione: qui il gate risolve un admin.
    h.requireDocente.mockResolvedValue({ user: { id: 'ad1', role: 'admin', scuola_id: 'sc-1' } })
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
    // Appendice logging: PATCH come POST — solo conteggi, niente nomi/id.
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:PATCH', esito: 'liberatoria-mancante', taggati: 2, senzaConsenso: 1 })
    expect(JSON.stringify(ev[0][2])).not.toContain('Bea')
  })

  it('422 togliendo il broadcast se i tag EFFETTIVI (dal DB, body senza tag_students) sono un gruppo non conforme', async () => {
    // Solo la Direzione può cambiare il broadcast: gate admin. I tag effettivi
    // vengono letti dal media esistente, non dal body.
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'admin', scuola_id: 'sc-1' } })
    h.utente = { ruolo: 'admin', scuola_id: 'sc-1' }
    h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: ['a', 'b'], is_broadcast: true, scuola_id: 'sc-1' }
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, is_broadcast: false }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.ids).toContain('b')
    expect(h.updated).toBeNull()
  })
})
