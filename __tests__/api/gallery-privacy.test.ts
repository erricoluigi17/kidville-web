import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-041 — Privacy Lock (Galleria) enforced server-side su POST e PATCH.
// Regola "foto privata": un solo bambino taggato è sempre pubblicabile (foto
// visibile solo ai suoi genitori); le foto di gruppo (≥2 taggati) richiedono la
// liberatoria (consenso_privacy === true) per OGNI bambino.
// Dal 2026-07-31 il broadcast NON bypassa più: una foto istituzionale non può
// taggare bambini (400) — vedi `__tests__/lib/gallery-privacy-broadcast.test.ts`.

const MSG_GRUPPO =
  'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).'

const MEDIA_ID = '11111111-1111-4111-8111-111111111111'
// Gli id degli alunni sono UUID, come in produzione: dal 2026-08-03 lo schema
// zod di `tag_students` lo pretende (`zUuid`), così un id malformato è un 400
// di validazione invece di un 500 dal cast di Postgres. Prima erano `'a'`/`'b'`,
// e un test scritto su valori che il server non accetterebbe mai è un test che
// prova un'altra rotta.
const ALUNNO_A = 'aaaaaaaa-1111-4111-8111-11111111111a'
const ALUNNO_B = 'bbbbbbbb-1111-4111-8111-11111111111b'
const ALUNNO_ALTRA_SEDE = 'cccccccc-1111-4111-8111-11111111111c'
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
      // `.in()` è CONCATENABILE e le due condizioni sono in AND:
      // `.in('id', tag).in('scuola_id', plessi)`. I filtri vanno quindi
      // ACCUMULATI, non sostituiti.
      //
      // ⚠️ Qui c'era un mock che, sulla `.in('scuola_id', …)`, rispondeva con
      // TUTTE le righe di quella sede ignorando il filtro sugli id — e la sua
      // `it` sul PATCH («OK se i tag effettivi restano un singolo bambino»)
      // sarebbe rimasta verde anche con un bambino di un altro plesso, che è
      // esattamente il difetto T05-F1. Un mock che tace è peggio di un mock che
      // manca: il secondo rompe il test, il primo lo certifica.
      const filtri: Record<string, Set<string>> = {}
      b.in = (colonna: string, valori: string[]) => {
        filtri[colonna] = new Set(valori ?? [])
        const righe = (table === 'alunni' ? h.alunni : []).filter((r) =>
          Object.entries(filtri).every(([c, ammessi]) =>
            ammessi.has(String((r as Record<string, unknown>)[c] ?? '')),
          ),
        )
        const b2 = { ...b } as Record<string, unknown>
        b2.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: righe, error: null }).then(res)
        return b2
      }
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
  // `scuola_id` è ora indispensabile: la POST nega i tag fuori dai propri plessi
  // PRIMA del Privacy Lock, e senza sede queste due righe risulterebbero estranee.
  h.alunni = [
    { id: ALUNNO_A, nome: 'Ada', cognome: 'Rossi', consenso_privacy: true, scuola_id: 'sc-1' },
    { id: ALUNNO_B, nome: 'Bea', cognome: 'Verdi', consenso_privacy: false, scuola_id: 'sc-1' },
  ]
  h.inserted = null
  h.updated = null
  // PATCH: l'identità è quella del gate ('ed1') e il media è suo → autorizzato
  // dal ramo educator-proprietario (uploaded_by === identità del gate). Il
  // body `userId` è tollerato per retro-compatibilità ma ignorato.
  h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: [ALUNNO_A], is_broadcast: false, scuola_id: 'sc-1' }
  h.utente = { ruolo: 'educator', scuola_id: 'sc-1' }
})

describe('POST /api/gallery — Privacy Lock', () => {
  it('422 sulla foto di GRUPPO se un taggato è senza liberatoria (messaggio + nomi/ids)', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: [ALUNNO_A, ALUNNO_B], is_broadcast: false }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.nomi).toContain('Bea Verdi')
    expect(j.ids).toContain(ALUNNO_B)
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
    const res = await POST(postReq({ file_url: 'u', tag_students: [ALUNNO_B], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: [ALUNNO_B] })
    // Appendice logging: l'evento critico logga anche il SUCCESSO (conteggi/flag).
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:POST', esito: 'pubblicata', nTag: 1, broadcast: false })
  })

  it('201 se tutti i taggati hanno consenso', async () => {
    const res = await POST(postReq({ file_url: 'u', tag_students: [ALUNNO_A], is_broadcast: false }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ tag_students: [ALUNNO_A] })
  })

  it('broadcast CON bambini taggati → 400 e nessuna riga scritta (il canale non spegne il consenso)', async () => {
    // Il broadcast è riservato alla Direzione: qui il gate risolve un admin.
    // Fino al 2026-07-31 questa stessa richiesta rispondeva 201 e pubblicava una
    // foto di gruppo di bambini senza liberatoria a tutta la sede (privacy F5).
    h.requireDocente.mockResolvedValue({ user: { id: 'ad1', role: 'admin', scuola_id: 'sc-1' } })
    const res = await POST(postReq({ file_url: 'u', tag_students: [ALUNNO_A, ALUNNO_B], is_broadcast: true }))
    expect(res.status).toBe(400)
    expect(h.inserted).toBeNull()
  })

  it('CONTROLLO POSITIVO — il broadcast SENZA tag resta pubblicabile dalla Direzione → 201', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ad1', role: 'admin', scuola_id: 'sc-1' } })
    const res = await POST(postReq({ file_url: 'u', tag_students: [], is_broadcast: true, target_classes: ['A'] }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ is_broadcast: true })
  })

  it('403 se non docente', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(postReq({ file_url: 'u' }))).status).toBe(403)
  })
})

describe('PATCH /api/gallery — Privacy Lock su modifica tag', () => {
  it('OK se i tag effettivi restano un singolo bambino (foto privata) — ed è un bambino DELLA MIA SEDE', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, tag_students: [ALUNNO_B] }))
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ tag_students: [ALUNNO_B] })
  })

  it('lo STESSO tag, ma il bambino è di un ALTRO plesso → 403, nessun update, nessun nome nel corpo', async () => {
    // Il controllo negativo che mancava: senza di lui la `it` qui sopra è vera
    // anche per un minore di un'altra sede — ed è così che il PATCH rispondeva
    // 422 con nome e cognome a chiunque conoscesse un uuid (T05-F1).
    h.alunni = [
      { id: ALUNNO_A, nome: 'Ada', cognome: 'Rossi', consenso_privacy: true, scuola_id: 'sc-1' },
      { id: ALUNNO_ALTRA_SEDE, nome: 'Bea', cognome: 'Verdi', consenso_privacy: false, scuola_id: 'sc-2' },
    ]
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, tag_students: [ALUNNO_ALTRA_SEDE] }))
    expect(res.status).toBe(403)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('Bea')
    expect(corpo).not.toContain('Verdi')
    expect(corpo).not.toContain(ALUNNO_ALTRA_SEDE)
    expect(h.updated).toBeNull()
    // Nel log solo conteggi: né nomi né uuid di minori.
    const ev = eventiGalleria()
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('warn')
    expect(ev[0][2]).toMatchObject({ operazione: 'gallery:PATCH', esito: 'tag-fuori-sede', taggati: 1, fuoriSede: 1 })
    expect(JSON.stringify(ev[0][2])).not.toContain(ALUNNO_ALTRA_SEDE)
  })

  it('422 se aggiungo un secondo bambino e uno è senza liberatoria', async () => {
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, tag_students: [ALUNNO_A, ALUNNO_B] }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.nomi).toContain('Bea Verdi')
    expect(j.ids).toContain(ALUNNO_B)
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
    h.media = { id: 'm1', uploaded_by: 'ed1', tag_students: [ALUNNO_A, ALUNNO_B], is_broadcast: true, scuola_id: 'sc-1' }
    const res = await PATCH(patchReq({ id: MEDIA_ID, userId: USER_ID, is_broadcast: false }))
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(j.error).toBe(MSG_GRUPPO)
    expect(j.ids).toContain(ALUNNO_B)
    expect(h.updated).toBeNull()
  })
})
