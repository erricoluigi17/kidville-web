import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// S08 — `GET /api/tasks`: chi sei lo dice la SESSIONE, non il parametro `userId`.
//
// Il difetto misurato in collaudo (backend F2): la route passava il gate con
// `requireDocente` (corretto) e poi ricostruiva ruolo e identità dal parametro
// di query `userId` — `.eq('id', userId)` per il ruolo, `const activeUserId =
// userId!` per i filtri. Bastava che un `educator` chiamasse la propria rotta
// con lo userId di un admin della sede per diventare `isManager` e vedere TUTTI
// i promemoria del plesso: quelli di cui non era né autore, né assegnatario, né
// destinatario di classe.
//
// Il ramo `?studentId=` era anche peggio: nessuna verifica di sezione, e la
// risposta portava nome, cognome, classe e ALLERGIE (`alunni.note_mediche`) del
// bambino collegato all'incarico. Sono dati sanitari di un minore.
//
// COME SI PROVA. Ogni asserzione negativa ha accanto il suo controllo positivo:
// una route che risponde sempre `[]` (o sempre 403) passerebbe metà di questi
// test, e sarebbe rotta. Si asserisce sul CORPO — quali id, quali campi — non
// sullo status: con il difetto lo status era 200 in entrambi i casi.
//
// Il finto Supabase applica DAVVERO i filtri: «l'educator non vede il task
// dell'admin» qui è una proprietà verificata, non dichiarata.
// =============================================================================

const ED_A = '11111111-1111-4111-8111-111111111111'
const ADM_A = '22222222-2222-4222-8222-222222222222'

const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRA_SEZIONE = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'

const SEC_MIA = 'sec-mia'
const SEC_ALTRUI = 'sec-altrui'
const CLASSE_MIA = '3 ANNI'
const CLASSE_ALTRUI = '4 ANNI'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
  }
})
// Si spia SOLO `logEvento`: serve a provare che il diniego LASCIA UNA TRACCIA,
// non solo un 403. `withRoute` manda 401/403/404 a `info` (mai in tabella): il
// `warn` lo deve emettere la route.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import { GET as TASKS_GET } from '@/app/api/tasks/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)

const eventi = (dominio: string) =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === dominio)
    .map((c) => c[2] as { tipo?: string; esito?: string } | undefined)

/** Il contenuto dei task vive in JSON dentro `contenuto` (vedi la route). */
const contenuto = (p: {
  autore: string
  assignees?: string[]
  status?: string
  scope?: string
  studentId?: string | null
}) =>
  JSON.stringify({
    real_author_id: p.autore,
    assignees: p.assignees ?? [],
    descrizione: '',
    status: p.status ?? 'todo',
    priority: 'medium',
    category: 'generale',
    deadline: null,
    compiti: [],
    target_scope: p.scope ?? 'single',
    target_role: null,
    student_id: p.studentId ?? null,
    resolved_by: null,
    resolution_notes: null,
    resolved_at: null,
  })

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
  scuole: [{ id: SEDE_A, attiva: true }],
  utenti_scuole: [],
  sections: [
    { id: SEC_MIA, scuola_id: SEDE_A, name: CLASSE_MIA },
    { id: SEC_ALTRUI, scuola_id: SEDE_A, name: CLASSE_ALTRUI },
  ],
  // `sections` annidato: il finto client non costruisce i join dalla stringa di
  // select, l'oggetto lo mette il fixture (è ciò che legge `nomiSezioniDiUtente`).
  utenti_sezioni: [{ utente_id: ED_A, section_id: SEC_MIA, sections: { name: CLASSE_MIA } }],
  utenti: [
    { id: ED_A, ruolo: 'educator', role: 'educator', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Edu' },
    { id: ADM_A, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A, nome: 'Dina', cognome: 'Direzione' },
  ],
  alunni: [
    {
      id: ALU_MIO, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE_MIA,
      section_id: SEC_MIA, scuola_id: SEDE_A, note_mediche: 'arachidi',
    },
    {
      id: ALU_ALTRA_SEZIONE, nome: 'Bea', cognome: 'Beta', classe_sezione: CLASSE_ALTRUI,
      section_id: SEC_ALTRUI, scuola_id: SEDE_A, note_mediche: 'lattosio',
    },
  ],
  parents: [],
  galleria_media_v2: [],
  task_interni: [
    {
      id: 'task-mio', author_id: ED_A, assigned_to: null, target_class: null,
      titolo: 'Il mio promemoria', contenuto: contenuto({ autore: ED_A }),
      completato: false, created_at: '2026-07-31T09:00:00.000Z', scuola_id: SEDE_A,
    },
    {
      id: 'task-admin', author_id: ADM_A, assigned_to: null, target_class: null,
      titolo: 'Riservato alla direzione', contenuto: contenuto({ autore: ADM_A }),
      completato: false, created_at: '2026-07-31T08:00:00.000Z', scuola_id: SEDE_A,
    },
    {
      id: 'task-admin-completato', author_id: ADM_A, assigned_to: null, target_class: null,
      titolo: 'Da rivedere, della direzione',
      contenuto: contenuto({ autore: ADM_A, status: 'completed' }),
      completato: false, created_at: '2026-07-31T07:00:00.000Z', scuola_id: SEDE_A,
    },
    {
      id: 'task-alunno-mio', author_id: ED_A, assigned_to: null, target_class: null,
      titolo: 'Colloquio', contenuto: contenuto({ autore: ED_A, studentId: ALU_MIO }),
      completato: false, created_at: '2026-07-31T06:00:00.000Z', scuola_id: SEDE_A,
    },
    {
      id: 'task-alunno-altrui', author_id: ADM_A, assigned_to: null, target_class: null,
      titolo: 'Colloquio altra sezione',
      contenuto: contenuto({ autore: ADM_A, studentId: ALU_ALTRA_SEZIONE }),
      completato: false, created_at: '2026-07-31T05:00:00.000Z', scuola_id: SEDE_A,
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.requireDocente.mockResolvedValue({ user: { id: ED_A, role: 'educator', scuola_id: SEDE_A } })
})

// -----------------------------------------------------------------------------
// L'identità dei filtri
// -----------------------------------------------------------------------------

describe('GET /api/tasks — l\'identità viene dalla sessione, non dal query param', () => {
  it('controllo positivo: con il PROPRIO userId l\'educator vede i propri promemoria', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ED_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id).sort()).toEqual(['task-alunno-mio', 'task-mio'])
  })

  it('passando lo userId dell\'ADMIN, l\'educator NON vede i promemoria della direzione', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ADM_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    // L'asserzione è sul CORPO: con il difetto lo status era 200 in entrambi i
    // casi, e cambiava solo il contenuto. `toEqual` esatto e non `not.toContain`:
    // così una route che smettesse di rispondere non passerebbe come «sicura».
    expect(j.map((t) => t.id).sort()).toEqual(['task-alunno-mio', 'task-mio'])
    // E il tentativo lascia una traccia persistita: un `userId` diverso dalla
    // sessione non è rumore, il client manda sempre l'id di chi ha la sessione.
    expect(eventi('auth')).toContainEqual(
      expect.objectContaining({ tipo: 'identita-da-query-ignorata' }),
    )
  })

  it('con lo userId che COINCIDE con la sessione non si logga niente (niente falsi segnali)', async () => {
    await TASKS_GET(req(`/api/tasks?userId=${ED_A}&filter=all`))
    expect(eventi('auth')).not.toContainEqual(
      expect.objectContaining({ tipo: 'identita-da-query-ignorata' }),
    )
  })

  it('`filter=to_review`: lo userId dell\'admin non apre i completati altrui', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ADM_A}&filter=to_review`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j).toEqual([])
  })

  it('controllo positivo: l\'admin con la PROPRIA sessione vede tutta la sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: ADM_A, role: 'admin', scuola_id: SEDE_A } })
    const res = await TASKS_GET(req(`/api/tasks?userId=${ADM_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id).sort()).toEqual([
      'task-admin', 'task-admin-completato', 'task-alunno-altrui', 'task-alunno-mio', 'task-mio',
    ])
  })

  it('l\'admin NON perde il ruolo se il client manda lo userId di un educator', async () => {
    // Il gemello del difetto, nell'altro verso: il ruolo lo dà la sessione, e un
    // parametro sbagliato non deve nemmeno DEGRADARE i permessi (sarebbe un
    // guasto funzionale silenzioso).
    h.requireDocente.mockResolvedValue({ user: { id: ADM_A, role: 'admin', scuola_id: SEDE_A } })
    const res = await TASKS_GET(req(`/api/tasks?userId=${ED_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id).sort()).toEqual([
      'task-admin', 'task-admin-completato', 'task-alunno-altrui', 'task-alunno-mio', 'task-mio',
    ])
  })
})

// -----------------------------------------------------------------------------
// Il ramo `?studentId=` — dati anagrafici e sanitari di un minore
// -----------------------------------------------------------------------------

describe('GET /api/tasks?studentId= — la sezione si verifica prima di parlare del bambino', () => {
  it('alunno di un\'altra sezione (stessa sede): 403, nessun dato del minore, task mai letti', async () => {
    const res = await TASKS_GET(req(`/api/tasks?studentId=${ALU_ALTRA_SEZIONE}&userId=${ED_A}`))
    expect(res.status).toBe(403)
    const corpo = await res.text()
    // Non basta lo status: con il difetto la risposta era 200 CON i dati. Qui si
    // prova che nel corpo non c'è NIENTE del bambino — nome, cognome, classe,
    // allergie (`note_mediche`).
    expect(corpo).not.toContain('Bea')
    expect(corpo).not.toContain('Beta')
    expect(corpo).not.toContain(CLASSE_ALTRUI)
    expect(corpo).not.toContain('lattosio')
    // …e che si è negato PRIMA di leggere gli incarichi: la verifica non è un
    // filtro applicato dopo aver interrogato la tabella.
    expect(h.tabelle).not.toContain('task_interni')
    // Il diniego lascia una traccia persistita: `withRoute` manda i 403 a `info`.
    expect(eventi('auth')).toContainEqual(expect.objectContaining({ tipo: 'alunno-fuori-sede' }))
  })

  it('controllo positivo: sull\'alunno della PROPRIA sezione l\'educator vede il task e l\'anagrafica', async () => {
    const res = await TASKS_GET(req(`/api/tasks?studentId=${ALU_MIO}&userId=${ED_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; student: { nome: string; cognome: string } | null }[]
    expect(j.map((t) => t.id)).toEqual(['task-alunno-mio'])
    expect(j[0].student).toEqual(expect.objectContaining({ nome: 'Ali', cognome: 'Alfa' }))
  })

  it('l\'admin vede anche l\'alunno di una sezione non sua (controllo positivo del ruolo)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: ADM_A, role: 'admin', scuola_id: SEDE_A } })
    const res = await TASKS_GET(req(`/api/tasks?studentId=${ALU_ALTRA_SEZIONE}&userId=${ADM_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id)).toEqual(['task-alunno-altrui'])
  })
})
