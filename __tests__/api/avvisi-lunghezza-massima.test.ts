import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'
import { MAX_TITOLO_AVVISO } from '@/lib/validation/avvisi'

// =============================================================================
// S34, la metà rimasta aperta — anche gli AVVISI dichiarano il massimo.
//
// Il rilievo backend F1 del 2026-07-31 è stato chiuso il 1° agosto **solo sui
// promemoria** (`__tests__/api/tasks-lunghezza-massima.test.ts`). Sugli avvisi era
// ancora riproducibile parola per parola:
//
//   POST /api/avvisi  { titolo: 'A'.repeat(100000) }
//     → HTTP 500 {"error":"value too long for type character varying(255)"}
//
// Due difetti in una risposta sola: un **400 di validazione travestito da 500**, e
// lo **schema del database raccontato al client** — a chi lavora in segreteria,
// per giunta, quel testo non dice niente.
//
// PERCHÉ ERA RIMASTO APERTO PROPRIO QUI. Avvisi e promemoria sono stati corretti
// da due esecutori diversi, e chi aveva in mano `tasks` non aveva ragione di
// guardare `avvisi`. È la stessa forma del difetto del PUT
// (`avvisi-put-classi-per-sede.test.ts`): la regola chiusa su una strada e
// lasciata aperta su quella accanto. Per questo il limite ora sta in un modulo
// solo, `@/lib/validation/avvisi`.
//
// I TEST DI CONFINE SONO LA PARTE CHE CONTA. «Rifiuta 100.000 caratteri» si
// otterrebbe anche con un massimo a caso: solo la coppia 255 passa / 256 no
// dimostra l'allineamento con la colonna vera, misurata su produzione il
// 2026-08-01 (`information_schema.columns`).
//
// Le asserzioni che contano sono sulla MUTAZIONE: dopo un rifiuto in `avvisi` non
// deve esserci nessuna riga. Uno status giusto con l'INSERT già partito sarebbe un
// falso verde.
// =============================================================================

const ADMIN = '11111111-1111-4111-8111-111111111111'
const AVVISO_ID = 'cccccccc-0000-4000-8000-00000000000c'
const CLASSE = 'TEST Infanzia'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
vi.mock('@/lib/avvisi/target-gate', () => ({
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: h.assertAvvisoInScope }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
      }),
  }
})

import { POST } from '@/app/api/avvisi/route'
import { PUT } from '@/app/api/avvisi/[id]/route'

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/avvisi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const put = (body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/avvisi/${AVVISO_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: AVVISO_ID }) },
  )

const dbBase = (): DBFinto => ({
  utenti: [{ id: ADMIN, ruolo: 'admin', role: 'admin', scuola_id: SEDE_A }],
  utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
  sections: [{ id: 'sec-a', scuola_id: SEDE_A, name: CLASSE }],
  alunni: [],
  legame_genitori_alunni: [],
  student_parents: [],
  parents: [],
  admin_settings: [
    { scuola_id: SEDE_A, avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'] } },
  ],
  avvisi: [
    {
      id: AVVISO_ID,
      author_id: ADMIN,
      titolo: 'Titolo iniziale',
      contenuto: 'Contenuto iniziale',
      tipo: 'presa_visione',
      target_scope: 'globale',
      target_classes: null,
      scuola_id: SEDE_A,
    },
  ],
  audit_scritture_docente: [],
})

const righeAvvisi = () => h.db.avvisi ?? []
const corpo = (titolo: string, extra: Record<string, unknown> = {}) => ({
  titolo,
  contenuto: 'Il corpo dell’avviso.',
  target_scope: 'globale',
  scuola_id: SEDE_A,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.assertAvvisoInScope.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/avvisi — il titolo dichiara il massimo della colonna', () => {
  it(`CONFINE: ${MAX_TITOLO_AVVISO} caratteri PASSANO (il limite non è più stretto della colonna)`, async () => {
    const res = await post(corpo('A'.repeat(MAX_TITOLO_AVVISO)))
    expect(res.status).toBe(201)
    expect(righeAvvisi().length).toBe(2)
  })

  it(`CONFINE: ${MAX_TITOLO_AVVISO + 1} caratteri ⇒ 400, e in tabella NON entra`, async () => {
    const res = await post(corpo('A'.repeat(MAX_TITOLO_AVVISO + 1)))
    expect(res.status).toBe(400)
    expect(righeAvvisi().length, 'nessuna riga nuova').toBe(1)
  })

  it('100.000 caratteri ⇒ 400 di validazione, non il 500 di Postgres', async () => {
    const res = await post(corpo('A'.repeat(100000)))
    expect(res.status).toBe(400)
    const corpoRisposta = JSON.stringify(await res.json())
    // Il difetto originale, in una riga: il tipo della colonna raccontato al client.
    expect(corpoRisposta).not.toContain('character varying')
    expect(corpoRisposta).not.toContain('value too long')
    expect(righeAvvisi().length).toBe(1)
  })

  it('il messaggio grezzo di PostgREST non torna MAI al client, nemmeno su un guasto vero', async () => {
    // Anche col massimo dichiarato, un errore di scrittura resta possibile (guasto,
    // vincolo, permesso). Il suo corpo appartiene al log, non alla risposta.
    h.errori = { avvisi: { code: '22001', message: 'value too long for type character varying(255)' } }
    const res = await post(corpo('Titolo legittimo'))
    expect(res.status).toBe(500)
    const corpoRisposta = JSON.stringify(await res.json())
    expect(corpoRisposta).not.toContain('character varying')
    expect(corpoRisposta).not.toContain('value too long')
  })
})

describe('POST /api/avvisi — anche i campi che non hanno una LARGHEZZA sono validati', () => {
  // La prima stesura di `@/lib/validation/avvisi` ha chiuso S34 guardando quali
  // colonne hanno un `character varying(n)`. `scadenza` è una `date` e
  // `target_classes` un array: nessun `.max()` da copiare dal DDL, quindi sono
  // scivolate via — e continuavano a produrre il 500 che S34 dichiarava chiuso, su
  // altre due colonne della stessa tabella. Il criterio giusto non è «come è fatto
  // il tipo» ma «che cosa può arrivare dal client».

  it('una `scadenza` che non è una data ⇒ 400, non il 500 di Postgres', async () => {
    const res = await post(corpo('Titolo valido', { scadenza: 'non-una-data' }))
    expect(res.status).toBe(400)
    const corpoRisposta = JSON.stringify(await res.json())
    // `22007 invalid input syntax for type date` non deve arrivare al client.
    expect(corpoRisposta).not.toContain('invalid input syntax')
    expect(corpoRisposta).not.toContain('type date')
    expect(righeAvvisi().length, 'nessuna riga nuova').toBe(1)
  })

  it('CONTROLLO POSITIVO: una scadenza valida passa ancora', async () => {
    const res = await post(corpo('Titolo valido', { scadenza: '2026-12-31' }))
    expect(res.status).toBe(201)
  })

  it('una data inesistente nel calendario ⇒ 400 (il 31 febbraio non è una scadenza)', async () => {
    const res = await post(corpo('Titolo valido', { scadenza: '2026-02-31' }))
    expect(res.status).toBe(400)
  })

  it('un nome di classe abnorme ⇒ 400, non 500', async () => {
    const res = await post(corpo('Titolo valido', {
      target_scope: 'classe',
      target_classes: ['A'.repeat(100000)],
    }))
    expect(res.status).toBe(400)
    expect(righeAvvisi().length).toBe(1)
  })

  it('un elenco di classi spropositato ⇒ 400 (le sezioni delle tre sedi sono 33)', async () => {
    const res = await post(corpo('Titolo valido', {
      target_scope: 'classe',
      target_classes: Array.from({ length: 3000 }, (_, i) => `C${i}`),
    }))
    expect(res.status).toBe(400)
    expect(righeAvvisi().length).toBe(1)
  })

  it('`target_classes` che non è un elenco di stringhe ⇒ 400', async () => {
    const res = await post(corpo('Titolo valido', { target_scope: 'classe', target_classes: [{ x: 1 }, 42] }))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/avvisi/[id] — lo stesso massimo, sulla strada accanto', () => {
  it(`CONFINE: ${MAX_TITOLO_AVVISO} caratteri PASSANO`, async () => {
    const res = await put(corpo('B'.repeat(MAX_TITOLO_AVVISO)))
    expect(res.status).toBe(200)
  })

  it(`CONFINE: ${MAX_TITOLO_AVVISO + 1} caratteri ⇒ 400, e la riga NON cambia`, async () => {
    const res = await put(corpo('B'.repeat(MAX_TITOLO_AVVISO + 1)))
    expect(res.status).toBe(400)
    expect(righeAvvisi()[0]?.titolo, 'il titolo resta quello di prima').toBe('Titolo iniziale')
  })
})
