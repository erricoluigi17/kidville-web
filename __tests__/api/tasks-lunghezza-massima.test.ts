import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// S34 — zod dichiara anche il MASSIMO, e il messaggio di Postgres resta nel log.
//
// Rilievo backend F1 del collaudo del 2026-07-31, misurato in produzione:
//
//   POST /api/tasks  { titolo: 'A'.repeat(100000) }
//     → HTTP 500 {"error":"value too long for type character varying(255)"}
//
// Due difetti in una risposta sola:
//
//  1. È un 400 DI VALIDAZIONE travestito da 500. Gli schemi zod dichiaravano il
//     tipo e il minimo (`z.string().min(1)`) ma non il massimo: il vincolo di
//     lunghezza viveva SOLO nel DDL
//     (`task_interni.titolo varchar(255)`, `target_class varchar(50)` —
//     supabase/migrations/20260704120000_baseline.sql:2710-2711). Chi valida a
//     metà lascia che sia il database a dire di no, e il database dice di no in
//     un modo che il chiamante non può capire né correggere.
//  2. La risposta RIGIRAVA `error.message` al client, cioè il tipo esatto della
//     colonna. È lo schema del database raccontato a chiunque sappia mandare una
//     stringa lunga — e a chi lavora in segreteria non dice assolutamente niente.
//
// PERCHÉ IL LIMITE È 255 E 50 E NON UN NUMERO A CASO. Un `.max()` più stretto del
// DDL rifiuterebbe dati legittimi; uno più largo lascerebbe il difetto aperto per
// i valori intermedi. Perciò i test di CONFINE (255 passa / 256 no, 50 passa /
// 51 no) sono la parte che conta: sono l'unica asserzione che dimostra
// l'allineamento con la colonna, invece di limitarsi a «rifiuta 100.000».
//
// E PERCHÉ IL 22001 RESTA UN 500 (deviazione dichiarata dal piano, che lo
// suggeriva «in subordine» a 400). Postgres conta CARATTERI, JavaScript conta
// unità UTF-16: `'😀'.length === 2` per JS e 1 per Postgres, quindi `.max(255)`
// su `String.length` è sempre ALMENO severo quanto la colonna, mai più largo.
// Con il massimo dichiarato, un 22001 su queste due rotte non può più venire dal
// chiamante: significa che la nostra dichiarazione e il DDL hanno divergiuto,
// cioè un difetto NOSTRO. Rispondere 400 lo addebiterebbe all'utente e — poiché
// `withRoute` manda i 5xx a `error` e i 400 a `warn` — abbasserebbe il livello
// del segnale proprio nel momento in cui serve alto. Quello che va chiuso, e qui
// si chiude, è la FUGA del messaggio: il corpo del guasto resta nel log, dove
// serve alla diagnosi, e non torna al client.
//
// Le asserzioni che contano sono sulla MUTAZIONE: dopo un rifiuto in
// `task_interni` non ci dev'essere nessuna riga nuova e nessuna riga cambiata.
// Uno status giusto con la scrittura comunque avvenuta sarebbe un falso verde.
// Accanto a ogni rifiuto c'è il CONTROLLO POSITIVO: senza, tutti i test qui
// sotto sarebbero verdi anche su una rotta che non scrive mai niente.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const EDU_A = '22222222-2222-4222-8222-222222222222'
const TASK_ID = 'dddddddd-0000-4000-8000-00000000000d'

/** I due limiti, presi dal DDL. Non sono opinioni: sono la larghezza della colonna. */
const MAX_TITOLO = 255
const MAX_TARGET_CLASS = 50

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  /** Ogni `logErrore`: il corpo del guasto deve finire QUI, non nella risposta. */
  errori: [] as { contesto: Record<string, unknown>; err: unknown }[],
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  erroriDb: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.erroriDb, scritture: h.scritture }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.erroriDb, scritture: h.scritture }),
  }
})
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: (contesto: Record<string, unknown>, err: unknown) => {
    h.errori.push({ contesto, err })
  },
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))

import { GET as TASKS_GET, POST as TASKS_POST } from '@/app/api/tasks/route'
import { PUT as TASK_PUT } from '@/app/api/tasks/[id]/route'

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const putReq = (body: unknown) =>
  new NextRequest(`http://localhost/api/tasks/${TASK_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

/** Le righe davvero presenti in `task_interni`, col titolo e la classe. */
const righe = () =>
  (h.db.task_interni ?? []).map((r) => ({ titolo: r.titolo, target_class: r.target_class }))

/** Ogni scrittura (insert/update/delete) davvero eseguita su `task_interni`. */
const scrittureTask = () => h.scritture.filter((s) => s.tabella === 'task_interni')

/** I campi che zod ha rifiutato, letti dal corpo del 400. */
async function campiRifiutati(res: Response): Promise<string[]> {
  const j = (await res.json()) as { error?: string; details?: { path: string }[] }
  expect(j.error, 'il 400 di validazione ha sempre il suo corpo standard').toBe('Dati non validi')
  return (j.details ?? []).map((d) => d.path)
}

const RIGA_ESISTENTE = () => ({
  id: TASK_ID,
  author_id: EDU_A,
  assigned_to: null,
  target_class: 'ORIGINALE',
  titolo: 'Titolo originale',
  contenuto: JSON.stringify({ real_author_id: EDU_A, assignees: [], descrizione: '', status: 'todo' }),
  completato: false,
  created_at: '2026-07-31T09:00:00.000Z',
  scuola_id: SEDE_A,
})

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
  scuole: [{ id: SEDE_A, attiva: true }],
  utenti_scuole: [],
  utenti_sezioni: [],
  sections: [{ id: 'sec-a', scuola_id: SEDE_A, name: '3 ANNI' }],
  utenti: [
    { id: ADMIN, ruolo: 'admin', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Direzione' },
    { id: EDU_A, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Elsa', cognome: 'Edu' },
  ],
  alunni: [],
  parents: [],
  galleria_media_v2: [],
  task_interni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriDb = {}
  h.errori = []
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireDocente.mockResolvedValue({ user: { id: EDU_A, role: 'educator', scuola_id: SEDE_A } })
})

// -----------------------------------------------------------------------------
// POST — il massimo si dichiara nello schema, non lo scopre il database
// -----------------------------------------------------------------------------

describe('POST /api/tasks — un titolo troppo lungo è un 400, non un 500', () => {
  it('il caso misurato in collaudo: titolo da 100.000 caratteri → 400 e NESSUNA riga scritta', async () => {
    const res = await TASKS_POST(postReq({ titolo: 'A'.repeat(100_000), author_id: EDU_A }))

    expect(res.status).toBe(400)
    expect(await campiRifiutati(res)).toContain('titolo')
    // LA MUTAZIONE: la tabella resta com'era, e nessuna insert è nemmeno partita.
    expect(righe()).toEqual([])
    expect(scrittureTask()).toEqual([])
  })

  it('il corpo del 400 non racconta com’è fatta la colonna', async () => {
    const res = await TASKS_POST(postReq({ titolo: 'A'.repeat(100_000), author_id: EDU_A }))

    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('character varying')
    expect(corpo).not.toContain('varchar')
  })

  it(`CONFINE: ${MAX_TITOLO} caratteri passano, ${MAX_TITOLO + 1} no (il limite è la colonna)`, async () => {
    const alLimite = 'A'.repeat(MAX_TITOLO)
    const ok = await TASKS_POST(postReq({ titolo: alLimite, author_id: EDU_A }))
    expect(ok.status, 'un titolo lungo esattamente quanto la colonna è legittimo').toBe(201)
    expect(righe()).toEqual([{ titolo: alLimite, target_class: null }])

    const oltre = await TASKS_POST(postReq({ titolo: 'A'.repeat(MAX_TITOLO + 1), author_id: EDU_A }))
    expect(oltre.status).toBe(400)
    // Nessuna SECONDA riga: la prima è quella del controllo positivo qui sopra.
    expect(righe()).toHaveLength(1)
  })

  it('il MINIMO non si è perso per strada: titolo vuoto ancora rifiutato', async () => {
    // Il `.min(1)` è passato da `z.string().min(1)` a `zTitoloTask.min(1)`:
    // il massimo non deve essere entrato al posto del minimo. Senza questo,
    // una catena scritta male renderebbe accettabile un promemoria senza
    // titolo, e nessuno degli altri test lo direbbe.
    const res = await TASKS_POST(postReq({ titolo: '', author_id: EDU_A }))

    expect(res.status).toBe(400)
    expect(await campiRifiutati(res)).toContain('titolo')
    expect(righe()).toEqual([])
  })

  it(`CONFINE su target_class: ${MAX_TARGET_CLASS} passano, ${MAX_TARGET_CLASS + 1} no`, async () => {
    const alLimite = 'C'.repeat(MAX_TARGET_CLASS)
    const ok = await TASKS_POST(postReq({ titolo: 'Promemoria', target_class: alLimite, author_id: EDU_A }))
    expect(ok.status).toBe(201)
    expect(righe()).toEqual([{ titolo: 'Promemoria', target_class: alLimite }])

    const oltre = await TASKS_POST(
      postReq({ titolo: 'Promemoria', target_class: 'C'.repeat(MAX_TARGET_CLASS + 1), author_id: EDU_A }),
    )
    expect(oltre.status).toBe(400)
    expect(await campiRifiutati(oltre)).toContain('target_class')
    expect(righe()).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// PUT — la stessa regola sull'aggiornamento, o il difetto rientra dalla finestra
// -----------------------------------------------------------------------------

describe('PUT /api/tasks/[id] — il massimo vale anche in aggiornamento', () => {
  beforeEach(() => {
    h.db.task_interni = [RIGA_ESISTENTE()]
  })

  it('titolo da 100.000 caratteri → 400 e la riga NON viene toccata', async () => {
    const res = await TASK_PUT(putReq({ titolo: 'A'.repeat(100_000) }), ctx(TASK_ID))

    expect(res.status).toBe(400)
    expect(await campiRifiutati(res)).toContain('titolo')
    // LA MUTAZIONE: il titolo in tabella è ancora quello di prima, e nessun
    // UPDATE è partito (nemmeno uno che non cambia niente).
    expect(righe()).toEqual([{ titolo: 'Titolo originale', target_class: 'ORIGINALE' }])
    expect(scrittureTask()).toEqual([])
  })

  it(`target_class oltre ${MAX_TARGET_CLASS} → 400 e nessun UPDATE`, async () => {
    const res = await TASK_PUT(
      putReq({ target_class: 'C'.repeat(MAX_TARGET_CLASS + 1) }),
      ctx(TASK_ID),
    )

    expect(res.status).toBe(400)
    expect(await campiRifiutati(res)).toContain('target_class')
    expect(righe()).toEqual([{ titolo: 'Titolo originale', target_class: 'ORIGINALE' }])
    expect(scrittureTask()).toEqual([])
  })

  it('CONTROLLO POSITIVO: al limite l’aggiornamento avviene davvero', async () => {
    const alLimite = 'A'.repeat(MAX_TITOLO)
    const res = await TASK_PUT(
      putReq({ titolo: alLimite, target_class: 'C'.repeat(MAX_TARGET_CLASS) }),
      ctx(TASK_ID),
    )

    expect(res.status).toBe(200)
    expect(righe()).toEqual([{ titolo: alLimite, target_class: 'C'.repeat(MAX_TARGET_CLASS) }])
    expect(scrittureTask()).toHaveLength(1)
    expect(scrittureTask()[0].operazione).toBe('update')
  })
})

// -----------------------------------------------------------------------------
// Il messaggio del database resta nel log — è la seconda metà del rilievo
// -----------------------------------------------------------------------------

describe('il messaggio grezzo di PostgREST non torna più al client', () => {
  const GUASTO = { code: '22001', message: 'value too long for type character varying(255)' }

  it('POST: guasto in scrittura → 500 generico, e il corpo del guasto sta nel log', async () => {
    h.erroriDb.task_interni = GUASTO

    const res = await TASKS_POST(postReq({ titolo: 'Promemoria', author_id: EDU_A }))

    expect(res.status).toBe(500)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('character varying')
    expect(corpo).not.toContain('value too long')
    // CONTROLLO POSITIVO: il corpo del guasto NON è stato buttato via. Senza
    // questa riga, un fix che semplicemente smette di loggare passerebbe.
    expect(JSON.stringify(h.errori)).toContain('value too long for type character varying(255)')
  })

  it('GET: guasto in lettura → 500 generico, e il corpo del guasto sta nel log', async () => {
    h.erroriDb.task_interni = { code: '08006', message: 'connection to server failed: kv_prod' }

    const res = await TASKS_GET(
      new NextRequest(`http://localhost/api/tasks?userId=${EDU_A}&filter=all`),
    )

    expect(res.status).toBe(500)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('connection to server failed')
    expect(corpo).not.toContain('kv_prod')
    expect(JSON.stringify(h.errori)).toContain('connection to server failed: kv_prod')
  })
})
