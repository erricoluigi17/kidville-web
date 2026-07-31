import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

// =============================================================================
// La bacheca interna dichiara la sua sede — `task_interni.scuola_id`.
//
// Il difetto (audit 2026-07-31, ultimo debito rimasto in allowlist nel lock
// `isolamento-sede-coverage`): `POST /api/tasks` scriveva
// `scuola_id: auth.user.scuola_id`, cioè la SEDE PRIMARIA di chi crea il
// promemoria — il ripiego che l'audit ha rimosso da `resolveScuolaScrittura` il
// 2026-07-31 perché con tre plessi non è un default: è solo la prima sede che è
// stata assegnata all'utente. Effetto reale: la direzione che nel SedeSelector
// sta lavorando su Cesa creava il promemoria **a Giugliano**, dove nessuno dello
// staff di Cesa lo vedeva — con 201 al chiamante e nessuna riga di log.
// Simmetrico in lettura: `tasks:GET` filtrava con `scuoleDiUtente` (TUTTE le
// sedi accessibili) invece che con `resolveScuoleAttive`, quindi la selezione di
// sede non aveva effetto sulla bacheca.
//
// Le asserzioni che contano qui sono sulla MUTAZIONE — quale riga è finita nel
// database e con quale `scuola_id` — non sullo status: un 403 con la scrittura
// comunque avvenuta è un falso verde, e un 201 sulla sede sbagliata pure.
// Il finto Supabase applica DAVVERO i filtri ed esegue DAVVERO le scritture.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const EDU_A = '22222222-2222-4222-8222-222222222222'
const EDU_ALTRO = '33333333-3333-4333-8333-333333333333'

const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const MEDIA = 'd0d0d0d0-0000-4000-8000-dddddddddddd'

const CLASSE_A = '3 ANNI'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture }),
  }
})
// Si spia SOLO `logEvento` (il resto del logger resta reale e silenzioso sotto
// VITEST): serve a provare che la creazione LASCIA UNA TRACCIA di successo, non
// solo che risponde 201 (AGENTS, «Logging obbligatorio», regola 5).
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))

import { GET as TASKS_GET, POST as TASKS_POST } from '@/app/api/tasks/route'

const req = (url: string, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined)

const postReq = (body: unknown, cookie?: string) =>
  new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: cookie
      ? { 'content-type': 'application/json', cookie }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const esiti = (dominio: string) =>
  h.logEvento.mock.calls
    .filter((c) => c[0] === dominio)
    .map((c) => c[2] as { esito?: string; sede_id?: string } | undefined)

/** Le righe davvero finite in `task_interni`, con la loro sede. */
const scritti = () =>
  (h.db.task_interni ?? []).map((r) => ({ titolo: r.titolo, scuola_id: r.scuola_id }))

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_C, nome: NOME_SEDE_C },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_C, attiva: true },
  ],
  // Il ponte multi-plesso della Direzione: ogni test lo riempie come gli serve.
  utenti_scuole: [],
  // Nessun legame docente↔sezione: è la condizione che ATTIVA il fallback
  // storico «deduci la sezione dagli alunni taggati nei tuoi media».
  utenti_sezioni: [],
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: CLASSE_A },
    { id: 'sec-b', scuola_id: SEDE_B, name: CLASSE_A },
  ],
  utenti: [
    { id: ADMIN, ruolo: 'admin', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Direzione' },
    { id: EDU_A, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Elsa', cognome: 'Edu' },
    { id: EDU_ALTRO, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Ivo', cognome: 'Altro' },
  ],
  alunni: [
    { id: ALU_A, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE_A, section_id: 'sec-a', scuola_id: SEDE_A },
  ],
  parents: [],
  galleria_media_v2: [],
  task_interni: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireDocente.mockResolvedValue({ user: { id: EDU_A, role: 'educator', scuola_id: SEDE_A } })
})

// -----------------------------------------------------------------------------
// POST — la sede si dichiara
// -----------------------------------------------------------------------------

describe('POST /api/tasks — il promemoria nasce nella sede su cui si sta lavorando', () => {
  it('la Direzione che lavora su una terza sede: la riga nasce LÌ, non nella sede primaria', async () => {
    // Ada è di Giugliano (sede primaria SEDE_A) ma nel SedeSelector ha scelto
    // SEDE_C. È il caso del difetto: con `auth.user.scuola_id` il promemoria
    // finiva nella sede primaria, e allo staff di SEDE_C non arrivava niente.
    h.db.utenti_scuole = [
      { utente_id: ADMIN, scuola_id: SEDE_B },
      { utente_id: ADMIN, scuola_id: SEDE_C },
    ]
    h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })

    const res = await TASKS_POST(
      postReq({ titolo: 'Controllo estintori', author_id: ADMIN }, `sedi_attive=${SEDE_C}`),
    )

    expect(res.status).toBe(201)
    // LA MUTAZIONE: una riga sola, e con la sede su cui si sta lavorando.
    expect(scritti()).toEqual([{ titolo: 'Controllo estintori', scuola_id: SEDE_C }])
    // Il successo lascia una traccia con la sede: senza, «nessun log» non
    // distingue «creato» da «non è mai partito niente».
    expect(esiti('multi_sede')).toContainEqual(
      expect.objectContaining({ esito: 'promemoria-creato', sede_id: SEDE_C }),
    )
  })

  it('sede dichiarata FUORI dai propri plessi: nessuna riga scritta, da nessuna parte', async () => {
    // Ada ha SEDE_A e SEDE_C; chiede di scrivere su SEDE_B, che non è sua.
    // Lo status resta volutamente non fissato a un valore solo: oggi
    // `resolveScuolaScrittura` scarta la preferita non accessibile e, restando
    // l'operazione ambigua, risponde 400; con la modifica in corso su
    // `src/lib/auth/scope.ts` una sede fuori scope diventerà un 403 esplicito.
    // Ciò che NON deve cambiare in nessuno dei due mondi è la mutazione: zero
    // righe scritte — né su SEDE_B, né «ripiegando» su una sede qualsiasi.
    h.db.utenti_scuole = [{ utente_id: ADMIN, scuola_id: SEDE_C }]
    h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })

    const res = await TASKS_POST(
      postReq({ titolo: 'Promemoria altrui', author_id: ADMIN, scuola_id: SEDE_B }),
    )

    expect([400, 403]).toContain(res.status)
    expect(scritti()).toEqual([])
    expect(h.scritture.filter((s) => s.tabella === 'task_interni')).toEqual([])
  })

  it('più sedi accessibili e nessuna indicata: 400, e la bacheca resta vuota', async () => {
    h.db.utenti_scuole = [{ utente_id: ADMIN, scuola_id: SEDE_B }]
    h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })

    const res = await TASKS_POST(postReq({ titolo: 'Dove lo metto?', author_id: ADMIN }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Specificare la sede (scuola_id) per questa operazione',
    })
    expect(scritti()).toEqual([])
  })

  it('CONTROLLO POSITIVO: un plesso solo, la riga si scrive e porta la sua sede', async () => {
    // Senza questo, i tre test qui sopra sarebbero verdi anche su una route che
    // non scrive mai niente.
    const res = await TASKS_POST(postReq({ titolo: 'Ordinare il materiale', author_id: EDU_A }))

    expect(res.status).toBe(201)
    expect(scritti()).toEqual([{ titolo: 'Ordinare il materiale', scuola_id: SEDE_A }])
    const creato = (await res.json()) as { titolo: string }
    expect(creato.titolo).toBe('Ordinare il materiale')
  })
})

// -----------------------------------------------------------------------------
// GET — si legge nelle sedi ATTIVE
// -----------------------------------------------------------------------------

describe('GET /api/tasks — la bacheca segue la selezione di sede', () => {
  beforeEach(() => {
    h.db.utenti_scuole = [{ utente_id: ADMIN, scuola_id: SEDE_B }]
    h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
    // ENTRAMBE le sedi popolate: se ne popolassi una sola, il test passerebbe
    // per assenza di dati invece che per il filtro.
    h.db.task_interni = [
      { id: 'task-a', author_id: EDU_ALTRO, assigned_to: null, target_class: null, titolo: 'Sede A', contenuto: null, completato: false, created_at: '2026-07-31T09:00:00.000Z', scuola_id: SEDE_A },
      { id: 'task-b', author_id: EDU_ALTRO, assigned_to: null, target_class: null, titolo: 'Sede B', contenuto: null, completato: false, created_at: '2026-07-31T08:00:00.000Z', scuola_id: SEDE_B },
    ]
  })

  it('con una sede selezionata si vede SOLO la sua, non tutte quelle accessibili', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ADMIN}&filter=all`, `sedi_attive=${SEDE_A}`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id)).toEqual(['task-a'])
  })

  it('CONTROLLO POSITIVO: senza selezione si vedono entrambe (le righe ci sono)', async () => {
    const res = await TASKS_GET(req(`/api/tasks?userId=${ADMIN}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id).sort()).toEqual(['task-a', 'task-b'])
  })
})

describe('GET /api/tasks — le sezioni dedotte dai media restano nella sede', () => {
  // Fallback storico: senza legami in `utenti_sezioni`, le «classi del docente»
  // si deducono dagli alunni che ha taggato nei propri media. La lettura dei
  // media non filtrava per sede — gemello esatto del difetto R112, che il 30/07
  // era stato chiuso solo sul secondo passaggio (gli alunni).
  beforeEach(() => {
    h.db.task_interni = [
      { id: 'task-classe', author_id: EDU_ALTRO, assigned_to: null, target_class: CLASSE_A, titolo: 'Compito di classe', contenuto: null, completato: false, created_at: '2026-07-31T09:00:00.000Z', scuola_id: SEDE_A },
    ]
  })

  it('un media caricato in un ALTRO plesso non porta dentro nessuna classe', async () => {
    // Elsa oggi è a SEDE_A; il media è un residuo del plesso in cui lavorava
    // prima (SEDE_B) e tagga un bambino che nel frattempo è a SEDE_A.
    h.db.galleria_media_v2 = [
      { id: MEDIA, scuola_id: SEDE_B, uploaded_by: EDU_A, is_broadcast: false, tag_students: [ALU_A], target_classes: null },
    ]
    const res = await TASKS_GET(req(`/api/tasks?userId=${EDU_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id)).toEqual([])
  })

  it('CONTROLLO POSITIVO: lo stesso media nella PROPRIA sede fa vedere il compito di classe', async () => {
    h.db.galleria_media_v2 = [
      { id: MEDIA, scuola_id: SEDE_A, uploaded_by: EDU_A, is_broadcast: false, tag_students: [ALU_A], target_classes: null },
    ]
    const res = await TASKS_GET(req(`/api/tasks?userId=${EDU_A}&filter=all`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string }[]
    expect(j.map((t) => t.id)).toEqual(['task-classe'])
  })
})
