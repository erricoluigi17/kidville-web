import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `sections`: la chiave di tenancy non si riscrive, il nome è unico per sede,
// i docenti restano nel plesso. (audit globale 2026-07-31, W2-D)
//
// PERCHÉ QUESTI TRE CONTROLLI STANNO INSIEME. `sections.scuola_id` è la chiave su
// cui poggia TUTTO il resto dell'isolamento: `assertSezioneInScope`,
// `assertClasseNomeInScope`, `sezioniVisibili` e ogni `.in('scuola_id', plessi)`
// rispondono a partire da lì. Finché `patchBodySchema` era `.loose()`, una PATCH
// con `{ id: <sezione di un'altra sede>, scuola_id: <la mia> }` spostava la
// classe nel proprio plesso — e da quell'istante ogni assert la considerava
// legittimamente propria, insieme a tutto ciò che vi è agganciato. Non era un
// IDOR: era la primitiva che DISARMA gli altri controlli.
//
// Il finto client filtra e SCRIVE davvero: qui non si asserisce solo lo stato
// HTTP, si asserisce **che cosa è finito nel database** (`h.db`) e **che cosa è
// stato spedito a PostgREST** (`h.scritture`). Un 403 che nel frattempo ha già
// mutato la riga non passa questi test.
// =============================================================================

const SEC_A1 = '11111111-1111-4111-8111-111111111111' // «2 ANNI» in SEDE_A
const SEC_A2 = '11111111-1111-4111-8111-111111111112' // «3 ANNI» in SEDE_A
const SEC_B1 = '22222222-2222-4222-8222-222222222221' // «2 ANNI» in SEDE_B (omonima: lecito)
const DOC_A = '33333333-3333-4333-8333-333333333331'
const DOC_B = '33333333-3333-4333-8333-333333333332'
const COORD_A = '44444444-4444-4444-8444-444444444441'
const ADMIN_AB = '44444444-4444-4444-8444-444444444442'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori as Record<string, ErrorePostgrest>,
      }),
  }
})

import { POST as SECTIONS_POST, PATCH as SECTIONS_PATCH } from '@/app/api/admin/sections/route'
import {
  GET as TEACHERS_GET,
  POST as TEACHERS_POST,
  DELETE as TEACHERS_DELETE,
} from '@/app/api/admin/sections/[id]/teachers/route'

const richiesta = (metodo: string, corpo: unknown, url = 'http://localhost/api/admin/sections') =>
  new NextRequest(url, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A1, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
    { id: SEC_A2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
    { id: SEC_B1, scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
  ],
  utenti: [
    { id: DOC_A, nome: 'Maestra', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A },
    { id: DOC_B, nome: 'Maestra', cognome: 'Beta', ruolo: 'educator', scuola_id: SEDE_B },
  ],
  utenti_sezioni: [{ utente_id: DOC_B, section_id: SEC_B1 }],
  utenti_scuole: [
    { utente_id: ADMIN_AB, scuola_id: SEDE_A },
    { utente_id: ADMIN_AB, scuola_id: SEDE_B },
  ],
  audit_scritture_docente: [],
})

/** Le scritture registrate dal finto client su una tabella. */
const scrittureSu = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

const sezione = (id: string) => h.db.sections.find((s) => s.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  // Coordinator di SEDE_A: `vedeTutteLeClassi` è vero (nessun vincolo di sezione
  // assegnata), e `scuoleDiUtente` vale esattamente [SEDE_A].
  h.requireStaff.mockResolvedValue({ user: { id: COORD_A, role: 'coordinator', scuola_id: SEDE_A } })
})

// -----------------------------------------------------------------------------
// PATCH /api/admin/sections
// -----------------------------------------------------------------------------
describe('PATCH /api/admin/sections — la chiave di tenancy non si riscrive', () => {
  it('`scuola_id` nel body NON viene mai scritto: la classe resta nel suo plesso', async () => {
    const res = await SECTIONS_PATCH(
      richiesta('PATCH', { id: SEC_A1, name: '2 ANNI A', scuola_id: SEDE_B }),
    )

    expect(res.status).toBe(200)
    // Lo stato del DATABASE, non la sola risposta: il nome cambia, la sede no.
    expect(sezione(SEC_A1)).toMatchObject({ scuola_id: SEDE_A, name: '2 ANNI A' })
    // E `scuola_id` non è nemmeno partito verso PostgREST.
    const update = scrittureSu('sections').find((s) => s.operazione === 'update')
    expect(update).toBeDefined()
    expect(Object.keys(update!.valori[0])).toEqual(['name'])
  })

  it('sezione di un\'altra sede: 403 e nessuna scrittura', async () => {
    const res = await SECTIONS_PATCH(richiesta('PATCH', { id: SEC_B1, name: 'RUBATA' }))

    expect(res.status).toBe(403)
    expect(sezione(SEC_B1)).toMatchObject({ scuola_id: SEDE_B, name: '2 ANNI' })
    expect(scrittureSu('sections')).toHaveLength(0)
  })

  it('rinomina su un nome già usato NELLA STESSA SEDE: 409 e nessuna scrittura', async () => {
    const res = await SECTIONS_PATCH(richiesta('PATCH', { id: SEC_A2, name: '2 ANNI' }))

    expect(res.status).toBe(409)
    expect(sezione(SEC_A2)).toMatchObject({ name: '3 ANNI' })
    expect(scrittureSu('sections')).toHaveLength(0)
  })

  it('rinomina su un nome usato in UN\'ALTRA sede: 200 (l\'omonimia fra plessi è lecita)', async () => {
    h.db.sections = [
      { id: SEC_A2, scuola_id: SEDE_A, name: '3 ANNI', school_type: 'infanzia' },
      { id: SEC_B1, scuola_id: SEDE_B, name: '5 ANNI', school_type: 'infanzia' },
    ]
    const res = await SECTIONS_PATCH(richiesta('PATCH', { id: SEC_A2, name: '5 ANNI' }))

    expect(res.status).toBe(200)
    expect(sezione(SEC_A2)).toMatchObject({ scuola_id: SEDE_A, name: '5 ANNI' })
  })

  it('id inesistente: 404 e nessuna scrittura', async () => {
    const res = await SECTIONS_PATCH(
      richiesta('PATCH', { id: '99999999-9999-4999-8999-999999999999', name: 'X' }),
    )

    expect(res.status).toBe(404)
    expect(scrittureSu('sections')).toHaveLength(0)
  })

  it('body con SOLO chiavi fuori allowlist: 400 e nessuna scrittura', async () => {
    const res = await SECTIONS_PATCH(
      richiesta('PATCH', { id: SEC_A1, scuola_id: SEDE_B, public_token: 'pwn' }),
    )

    expect(res.status).toBe(400)
    expect(sezione(SEC_A1)).toMatchObject({ scuola_id: SEDE_A, name: '2 ANNI' })
    expect(scrittureSu('sections')).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// POST /api/admin/sections
// -----------------------------------------------------------------------------
describe('POST /api/admin/sections — un nome, una sede', () => {
  it('duplicato nella stessa sede: 409 e nessun insert', async () => {
    const res = await SECTIONS_POST(
      richiesta('POST', { name: '2 ANNI', school_type: 'infanzia' }),
    )

    expect(res.status).toBe(409)
    expect(scrittureSu('sections')).toHaveLength(0)
    expect(h.db.sections).toHaveLength(3)
  })

  it('stesso nome in un\'ALTRA sede: 201, e l\'insert dichiara la sede scelta', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN_AB, role: 'admin', scuola_id: SEDE_A } })

    const res = await SECTIONS_POST(
      richiesta('POST', { name: '3 ANNI', school_type: 'infanzia', scuola_id: SEDE_B }),
    )

    expect(res.status).toBe(201)
    const insert = scrittureSu('sections').find((s) => s.operazione === 'insert')
    expect(insert?.valori[0]).toMatchObject({ name: '3 ANNI', scuola_id: SEDE_B })
    expect(h.db.sections.filter((s) => s.name === '3 ANNI').map((s) => s.scuola_id)).toEqual([
      SEDE_A,
      SEDE_B,
    ])
  })

  it('duplicato intercettato dal VINCOLO del database (23505): 409, non 500', async () => {
    // Il controllo preventivo non vede nulla (prima lettura pulita), l'indice
    // unico sì: è la corsa fra due click, e la risposta deve restare leggibile.
    let letture = 0
    h.errori = {
      get sections() {
        return ++letture >= 2
          ? { code: '23505', message: 'duplicate key value violates unique constraint "sections_nome_per_sede"' }
          : undefined
      },
    }

    const res = await SECTIONS_POST(richiesta('POST', { name: 'NUOVISSIMA' }))

    expect(res.status).toBe(409)
  })
})

// -----------------------------------------------------------------------------
// /api/admin/sections/[id]/teachers
// -----------------------------------------------------------------------------
describe('POST/DELETE /api/admin/sections/[id]/teachers — i docenti restano nel plesso', () => {
  const urlTeachers = (id: string) => `http://localhost/api/admin/sections/${id}/teachers`

  it('sezione di un\'altra sede: 403 e `utenti_sezioni` intatta', async () => {
    const res = await TEACHERS_POST(
      richiesta('POST', { utente_id: DOC_A }, urlTeachers(SEC_B1)),
      ctx(SEC_B1),
    )

    expect(res.status).toBe(403)
    expect(scrittureSu('utenti_sezioni')).toHaveLength(0)
    expect(h.db.utenti_sezioni).toEqual([{ utente_id: DOC_B, section_id: SEC_B1 }])
  })

  it('docente di un\'altra sede su sezione propria: 403 e `utenti_sezioni` intatta', async () => {
    const res = await TEACHERS_POST(
      richiesta('POST', { utente_id: DOC_B }, urlTeachers(SEC_A1)),
      ctx(SEC_A1),
    )

    expect(res.status).toBe(403)
    expect(scrittureSu('utenti_sezioni')).toHaveLength(0)
    expect(h.db.utenti_sezioni).toEqual([{ utente_id: DOC_B, section_id: SEC_B1 }])
  })

  it('sezione e docente della propria sede: 200 e il legame è nel database', async () => {
    const res = await TEACHERS_POST(
      richiesta('POST', { utente_id: DOC_A }, urlTeachers(SEC_A1)),
      ctx(SEC_A1),
    )

    expect(res.status).toBe(200)
    expect(h.db.utenti_sezioni).toContainEqual(
      expect.objectContaining({ utente_id: DOC_A, section_id: SEC_A1 }),
    )
  })

  it('DELETE su sezione di un\'altra sede: 403 e il legame altrui resta in piedi', async () => {
    const res = await TEACHERS_DELETE(
      richiesta('DELETE', { utente_id: DOC_B }, urlTeachers(SEC_B1)),
      ctx(SEC_B1),
    )

    expect(res.status).toBe(403)
    expect(scrittureSu('utenti_sezioni')).toHaveLength(0)
    expect(h.db.utenti_sezioni).toEqual([{ utente_id: DOC_B, section_id: SEC_B1 }])
  })

  it('GET su sezione di un\'altra sede: 403, senza elencare il personale altrui', async () => {
    const res = await TEACHERS_GET(
      new NextRequest(urlTeachers(SEC_B1)),
      ctx(SEC_B1),
    )

    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('utenti')
  })
})
