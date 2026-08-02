import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, ErrorePostgrest, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// `/api/admin/schools` — il gate verifica l'OGGETTO, non solo chi lo chiede.
//
// Misurato in produzione il 2026-07-31: un `coordinator` di Giugliano —
// mono-plesso per modello (`scuoleDiUtente` concede il ponte `utenti_scuole` ai
// soli `admin`) — riceveva **HTTP 200** da
//
//   PATCH /api/admin/schools  {"id":"<uuid di un'altra sede>"}
//
// cioè poteva riscrivere nome, città, indirizzo, `config` intera (dentro c'è
// l'anagrafica fiscale che finisce in fattura: PEC, P.IVA, codice
// meccanografico) e il flag `attiva` di QUALUNQUE sede del deployment,
// disattivando un plesso vero. Il gate a `route.ts:350` verificava solo il
// RUOLO: chi sei, non su cosa stai agendo. E `GET` elencava tutte e quattro le
// sedi — comprese le due non sue e la sede fittizia della CI, che
// `/api/iscrizione/sedi` invece esclude da sempre.
//
// METODO. Le asserzioni che contano qui sono sulla MUTAZIONE, non sullo status:
// il finto client ESEGUE le scritture, quindi «403» si prova guardando che la
// riga dell'altra sede sia rimasta identica — `updated_at` compreso, che è
// l'unico campo che la prova del tester ha davvero spostato. Ogni asserzione
// negativa ha accanto il suo controllo positivo (la stessa operazione sulla
// PROPRIA sede deve continuare a funzionare), altrimenti un gate che nega tutto
// passerebbe per un gate corretto.
// =============================================================================

const COORDINATOR = '33333333-3333-4333-8333-333333333333'
const ADMIN_TRE_SEDI = '11111111-1111-4111-8111-111111111111'
const ADMIN_COLLAUDO = '22222222-2222-4222-8222-222222222222'

/** Timestamp di partenza delle righe: se resta questo, nessuno ha scritto. */
const INTOCCATO = '2026-07-10T12:14:48.157Z'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  /** tabella → errore PostgREST su OGNI operazione: serve a provare i guasti di lettura. */
  errori: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})
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

import { GET, POST, PATCH } from '@/app/api/admin/schools/route'

const patch = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const get = () => new Request('http://localhost/api/admin/schools')

const dbBase = (): DBFinto => ({
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A, citta: 'Alfaville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
    { id: SEDE_B, nome: NOME_SEDE_B, citta: 'Betaville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E, citta: 'Testville', indirizzo: null, attiva: true, config: {}, created_at: INTOCCATO, updated_at: INTOCCATO },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_E2E, nome: NOME_SEDE_E2E },
  ],
  utenti: [
    { id: ADMIN_TRE_SEDI, ruolo: 'admin', scuola_id: SEDE_A },
    { id: ADMIN_COLLAUDO, ruolo: 'admin', scuola_id: SEDE_E2E },
    { id: COORDINATOR, ruolo: 'coordinator', scuola_id: SEDE_A },
  ],
  // Il ponte multi-plesso: per modello lo legge SOLO l'admin (`scope.ts:58`).
  utenti_scuole: [
    { utente_id: ADMIN_TRE_SEDI, scuola_id: SEDE_A },
    { utente_id: ADMIN_TRE_SEDI, scuola_id: SEDE_B },
  ],
  admin_settings: [],
})

/** La riga di `scuole` com'è ADESSO nel database finto. */
const riga = (id: string) => (h.db.scuole ?? []).find((r) => r.id === id) ?? {}

/** Le righe di `scuole` toccate da una scrittura, quale che sia l'operazione. */
const scrittureSuScuole = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'scuole' && s.colpite.length > 0)

/** I `warn` di sicurezza emessi (livello `warn` = persistito in `app_log`). */
const warn = () =>
  h.logEvento.mock.calls.filter((c) => c[1] === 'warn').map((c) => c[2] as Record<string, unknown>)

const comeCoordinatorDiA = () =>
  h.requireStaff.mockResolvedValue({ user: { id: COORDINATOR, role: 'coordinator', scuola_id: SEDE_A } })

const comeAdminDiAeB = () =>
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN_TRE_SEDI, role: 'admin', scuola_id: SEDE_A } })

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  comeCoordinatorDiA()
})

describe('PATCH /api/admin/schools — si opera solo sulle proprie sedi', () => {
  it('il coordinator di una sede NON tocca la sede di un altro plesso (403, riga invariata)', async () => {
    const res = await PATCH(patch({ id: SEDE_B, nome: 'Sede Dirottata', attiva: false }))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' })
    // L'asserzione che conta: la riga dell'altra sede è rimasta com'era. Nella
    // riproduzione del collaudo l'unico campo alterato era `updated_at` — se
    // cambia quello, la scrittura è passata.
    expect(riga(SEDE_B)).toMatchObject({ nome: NOME_SEDE_B, attiva: true, updated_at: INTOCCATO })
    expect(scrittureSuScuole()).toEqual([])
  })

  it('CONTROLLO POSITIVO: sulla PROPRIA sede la modifica passa e cambia davvero il dato', async () => {
    const res = await PATCH(patch({ id: SEDE_A, nome: 'Kidville Alfa Centro' }))

    expect(res.status).toBe(200)
    expect(riga(SEDE_A)).toMatchObject({ nome: 'Kidville Alfa Centro' })
    expect(riga(SEDE_A).updated_at).not.toBe(INTOCCATO)
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('il diniego lascia un segnale di sicurezza (warn persistito), non solo un 403 muto', async () => {
    await PATCH(patch({ id: SEDE_B, nome: 'Sede Dirottata' }))

    expect(warn()).toContainEqual(
      expect.objectContaining({
        tipo: 'sede-scrittura-fuori-scope',
        azione: 'admin/schools:PATCH',
        utente: COORDINATOR,
        ruolo: 'coordinator',
      }),
    )
    // Nessun dato personale e nessun uuid di sede in chiaro nella riga di log,
    // come nelle altre `*-fuori-scope` del modulo.
    const riga0 = warn()[0]
    expect(JSON.stringify(riga0)).not.toContain(SEDE_B)
  })

  it("l'admin multi-plesso opera sulle sedi del suo ponte `utenti_scuole`", async () => {
    comeAdminDiAeB()
    const res = await PATCH(patch({ id: SEDE_B, nome: 'Kidville Beta Centro' }))

    expect(res.status).toBe(200)
    expect(riga(SEDE_B)).toMatchObject({ nome: 'Kidville Beta Centro' })
  })

  it("l'admin NON tocca una sede fuori dal suo ponte (nemmeno quella della CI)", async () => {
    comeAdminDiAeB()
    const res = await PATCH(patch({ id: SEDE_E2E, attiva: false }))

    expect(res.status).toBe(403)
    expect(riga(SEDE_E2E)).toMatchObject({ attiva: true, updated_at: INTOCCATO })
    expect(scrittureSuScuole()).toEqual([])
  })

  it('«non esiste» resta 404 e non diventa «non è tua» (due dinieghi diversi)', async () => {
    comeAdminDiAeB()
    const res = await PATCH(patch({ id: 'cccccccc-0000-4000-8000-00000000000c', nome: 'X' }))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Sede non trovata' })
  })

  it('un GUASTO di lettura è 500, non «Sede non trovata» (PostgREST non lancia)', async () => {
    // La lettura da cui dipende TUTTO il gate — se `{ error }` non si guarda,
    // `existing` resta null e la route risponde 404 su un dato che non ha letto:
    // dice «quella sede non c'è» a un admin la cui sede c'è eccome, e il guasto
    // sparisce dentro un diniego che sembra normale.
    comeAdminDiAeB()
    h.errori = { scuole: { message: 'connessione interrotta', code: '08006' } }

    const res = await PATCH(patch({ id: SEDE_A, nome: 'X' }))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Verifica di scope non riuscita' })
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'admin/schools:PATCH', evento: 'db-scuole-lettura' }),
      expect.objectContaining({ code: '08006' }),
    )
    // E soprattutto: nessuno ha scritto niente.
    expect(riga(SEDE_A)).toMatchObject({ nome: NOME_SEDE_A, updated_at: INTOCCATO })
  })
})

describe('GET /api/admin/schools — si vedono solo le proprie sedi', () => {
  it('il coordinator vede la SUA sede e nessun altro plesso', async () => {
    const res = await GET(get())
    const sedi = (await res.json()) as { id: string }[]

    expect(res.status).toBe(200)
    expect(sedi.map((s) => s.id)).toEqual([SEDE_A])
  })

  it('la sede fittizia della CI non compare a un utente vero, nemmeno se è nel suo ponte', async () => {
    h.db.utenti_scuole = [
      { utente_id: ADMIN_TRE_SEDI, scuola_id: SEDE_A },
      { utente_id: ADMIN_TRE_SEDI, scuola_id: SEDE_E2E },
    ]
    comeAdminDiAeB()
    const res = await GET(get())
    const sedi = (await res.json()) as { id: string }[]

    expect(sedi.map((s) => s.id)).not.toContain(SEDE_E2E)
    // Controllo positivo: la sede vera dello stesso elenco c'è ancora — senza,
    // un filtro che azzera tutto passerebbe per un filtro corretto.
    expect(sedi.map((s) => s.id)).toEqual([SEDE_A])
  })

  it("l'account di collaudo continua a vedere la sua sede finta (o la CI resta senza sedi)", async () => {
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN_COLLAUDO, role: 'admin', scuola_id: SEDE_E2E } })
    const res = await GET(get())
    const sedi = (await res.json()) as { id: string }[]

    expect(sedi.map((s) => s.id)).toEqual([SEDE_E2E])
  })
})

describe('POST /api/admin/schools — creare un plesso è atto della Direzione multi-sede', () => {
  it('il coordinator non crea sedi (403) e non scrive niente', async () => {
    // Il gate di ruolo vero: `requireStaff` è mockato, quindi qui si verifica che
    // la route CHIEDA `['admin']` e non più `['admin','coordinator']`.
    h.requireStaff.mockImplementation(async (_req: Request, ammessi: string[]) =>
      ammessi.includes('coordinator')
        ? { user: { id: COORDINATOR, role: 'coordinator', scuola_id: SEDE_A } }
        : { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) },
    )
    const res = await POST(post({ nome: 'Kidville Nuova' }))

    expect(res.status).toBe(403)
    expect((h.db.scuole ?? []).map((r) => r.id)).toEqual([SEDE_A, SEDE_B, SEDE_E2E])
  })
})
