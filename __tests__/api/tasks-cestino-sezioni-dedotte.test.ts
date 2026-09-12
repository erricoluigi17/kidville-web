import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `tasks:GET` — UNA FOTO NEL CESTINO NON RESUSCITA UNA SEZIONE, E QUINDI NON
// RESUSCITA I PROMEMORIA DI QUELLA CLASSE.
//
// ─── Perché questo file esiste, e perché è nato da una BOCCIATURA ────────────
//
// `tasks:GET` deduce le sezioni di un docente senza legami in `utenti_sezioni`
// dalle foto che ha caricato lui (fallback storico), e da quelle sezioni decide
// quali promemoria `target_class` gli mostra. Dal 2026-09-11 una foto eliminata
// non è distrutta: è nel CESTINO, e la route la filtra con `leggiVive`.
//
// Il primo giro di questo lavoro è stato bocciato proprio qui, e il rilievo era
// esatto: il lock `cestino-galleria-ogni-lettura-dichiara` pretendeva che
// `leggiVive` fosse NOMINATO, non che il filtro fosse APPLICATO. Riscrivendo
// `(vive) => vive(q)…` in `() => (q)…` il filtro del cestino spariva e restavano
// verdi il lock (7/7), `eslint`, `tsc` e ogni test del repo — perché delle tre
// sedi di `leggiVive` questa era l'unica senza una prova di COMPORTAMENTO.
// Il lock adesso guarda anche dentro il thunk; questo file è l'altra metà, e le
// due sono indipendenti: se un giorno il riconoscitore si rompesse di nuovo,
// questa prova lo prenderebbe comunque, perché non legge il sorgente — esegue la
// rotta.
//
// ─── Cosa rende la prova valida, e non un mock piatto ────────────────────────
//
// `creaFintoSupabase` APPLICA DAVVERO i filtri: `.is('eliminato_il', null)` viene
// eseguito sulle righe (`is null` è vero anche sul campo assente, come in
// PostgREST). Quindi il verde e il rosso dipendono dal filtro nella rotta, non da
// un finto client che risponde sempre la stessa lista. Le due prove sono una
// COPPIA: stesso materiale, cambia SOLO `eliminato_il` sull'unico media — senza
// il caso positivo accanto, un elenco vuoto potrebbe venire da qualunque altra
// cosa (lo scope, il gate, un refuso nel nome della classe).
// =============================================================================

const ED = '11111111-1111-4111-8111-111111111111'
const ED_ALTRO = '99999999-9999-4999-8999-999999999999'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const MEDIA = 'd0d0d0d0-0000-4000-8000-dddddddddddd'
const CLASSE = '3 ANNI A'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/require-staff')>()),
  requireDocente: h.requireDocente,
  requireUser: h.requireUser,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import { GET as TASKS_GET } from '@/app/api/tasks/route'

const req = () => new NextRequest(`http://localhost/api/tasks?userId=${ED}&filter=all`)

/** Il media che fa dedurre la sezione: `eliminato_il` è l'unico campo che cambia. */
const mediaTaggato = (eliminatoIl: string | null): Record<string, unknown> => ({
  id: MEDIA,
  scuola_id: SEDE_A,
  uploaded_by: ED,
  is_broadcast: false,
  tag_students: [ALUNNO],
  target_classes: null,
  eliminato_il: eliminatoIl,
  file_rimosso_il: null,
})

const dbBase = (): DBFinto => ({
  schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
  scuole: [{ id: SEDE_A, attiva: true }],
  utenti_scuole: [],
  // Vuota di proposito: è la condizione che ATTIVA il fallback «deduci la
  // sezione dalle foto caricate», cioè il ramo che legge `galleria_media_v2`.
  utenti_sezioni: [],
  sections: [{ id: 'sec-a', scuola_id: SEDE_A, name: CLASSE }],
  utenti: [
    { id: ED, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Ada', cognome: 'Edu' },
    { id: ED_ALTRO, ruolo: 'educator', scuola_id: SEDE_A, nome: 'Ivo', cognome: 'Altro' },
  ],
  alunni: [
    { id: ALUNNO, nome: 'Ali', cognome: 'Alfa', classe_sezione: CLASSE, section_id: 'sec-a', scuola_id: SEDE_A, stato: 'iscritto' },
  ],
  // Il promemoria arriva al docente SOLO per `target_class`: non è suo (l'autore
  // è un collega), non gli è assegnato, non è `global` né `role`. È l'unica via,
  // quindi l'unica cosa che può farlo comparire è la sezione dedotta.
  task_interni: [
    {
      id: 'task-3anni',
      author_id: ED_ALTRO,
      assigned_to: null,
      target_class: CLASSE,
      titolo: 'Compito 3 ANNI A',
      contenuto: null,
      completato: false,
      created_at: '2026-09-11T09:00:00.000Z',
      scuola_id: SEDE_A,
    },
  ],
  galleria_media_v2: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireDocente.mockResolvedValue({ user: { id: ED, role: 'educator', scuola_id: SEDE_A } })
  h.requireUser.mockResolvedValue({ user: { id: ED, role: 'educator', scuola_id: SEDE_A } })
})

const idsRestituiti = async (): Promise<string[]> => {
  const res = await TASKS_GET(req())
  expect(res.status).toBe(200)
  const j = (await res.json()) as { id: string }[]
  return j.map((t) => t.id)
}

describe('GET /api/tasks — la sezione dedotta dalle foto e il cestino', () => {
  it('CASO POSITIVO: con la foto VIVA la sezione si deduce e il promemoria arriva', async () => {
    h.db.galleria_media_v2 = [mediaTaggato(null)]
    // Senza questa metà, la prova qui sotto sarebbe compatibile con «la route
    // non legge affatto i media» e con «la classe si chiama diversamente».
    expect(await idsRestituiti()).toEqual(['task-3anni'])
    // E la tabella è stata letta davvero: il ramo esiste ed è passato da qui.
    expect(h.tabelle).toContain('galleria_media_v2')
  })

  it('CASO DEL CESTINO: con `eliminato_il` valorizzato la sezione NON si deduce', async () => {
    h.db.galleria_media_v2 = [mediaTaggato('2026-09-11T10:00:00.000Z')]
    // Cambia SOLO `eliminato_il`. Se il filtro del cestino non entra nella query
    // — `leggiVive` nominato ma `vive` non applicato, che è il difetto misurato —
    // questa riga torna `['task-3anni']` e la prova diventa rossa.
    expect(await idsRestituiti()).toEqual([])
  })

  it('una foto cestinata il cui FILE è già uscito resta fuori come le altre', async () => {
    // `file_rimosso_il` non allenta niente: il verso di questa lettura è
    // `eliminato_il IS NULL`, e una riga oltre la purga è cestinata a maggior
    // ragione. Serve a fissare che il filtro è sulla PRIMA colonna, non sulla
    // seconda — `soloNelCestino` le usa entrambe, questa vista solo la prima.
    h.db.galleria_media_v2 = [
      { ...mediaTaggato('2026-07-01T10:00:00.000Z'), file_rimosso_il: '2026-08-01T10:00:00.000Z' },
    ]
    expect(await idsRestituiti()).toEqual([])
  })
})
