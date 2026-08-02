import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W2-N · R27 · R28 · R42 — «ogni scrittura dichiara la sua sede»
//
// In produzione 12 presenze su 49 e 4 righe di armadietto su 4 hanno
// `scuola_id` NULL: la colonna che separa i plessi è vuota proprio sulle righe
// scritte da queste route. Oggi non si perde nulla perché i lettori partono
// dagli `alunni` già filtrati; ma la riga senza sede è invisibile a QUALUNQUE
// filtro `.in('scuola_id', plessi)` — e quel filtro è già il modo in cui
// filtrano decine di query nel repo. Il giorno che qualcuno lo scrive anche
// qui, il registro presenze si accorcia senza un errore.
//
// Questi test NON guardano lo status: guardano CHE COSA è finito nel database
// (accumulatore `scritture` del finto client + stato di `h.db`). Un 200 con la
// sede mancante è esattamente il difetto.
// =============================================================================

const SEZ_A = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const GIORNO = '2026-07-31'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  /** Quante letture di `sections` devono ancora passare prima di rompersi.
   *  0 = nessun guasto (default); 1 = la PRIMA passa (il gate), la seconda no. */
  erroriSections: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({
  notificaTitolariScrittura: vi.fn(),
  enqueueDiarioGenitori: vi.fn(),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // `errori` è letto a ogni `from(tabella)`: il getter fa passare le prime
  // `erroriSections` letture di `sections` e rompe le successive, così si può
  // provare il guasto DOPO il gate senza toccare il gate stesso.
  let viste = 0
  const errori = {
    get sections() {
      if (h.erroriSections === 0) return undefined
      viste++
      return viste > h.erroriSections
        ? { code: '08006', message: 'connessione persa' }
        : undefined
    },
  }
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, {
      scritture: h.scritture as Scrittura[],
      errori: errori as never,
    })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { POST as POST_APPELLO } from '@/app/api/primaria/appello/route'
import { POST as POST_CARICO, PATCH as PATCH_CONSUMO } from '@/app/api/locker/inventory/route'
import { POST as POST_DIARIO } from '@/app/api/diary/entries/route'

const scrittureSu = (tabella: string, operazione: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella && s.operazione === operazione)

const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '2 ANNI', school_type: 'infanzia' },
    { id: 'sec-b', scuola_id: SEDE_B, name: '2 ANNI', school_type: 'infanzia' },
  ],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: '2 ANNI', section_id: SEZ_A, scuola_id: SEDE_A, usa_pannolino: true },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: '2 ANNI', section_id: 'sec-b', scuola_id: SEDE_B, usa_pannolino: true },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_A }],
  presenze: [],
  armadietto: [],
  eventi_diario: [],
  notifiche: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriSections = 0
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore', scuola_id: null } })
})

describe('POST /api/primaria/appello — la presenza nasce con la sede della sezione', () => {
  it('l\'upsert porta scuola_id, e la riga in `presenze` ce l\'ha', async () => {
    const res = await POST_APPELLO(
      post('http://localhost/api/primaria/appello', {
        sectionId: SEZ_A,
        data: GIORNO,
        records: [{ alunnoId: ALU_A, stato: 'presente' }],
      }),
    )
    expect(res.status).toBe(200)

    const upsert = scrittureSu('presenze', 'upsert')
    expect(upsert).toHaveLength(1)
    expect(upsert[0].valori[0]).toMatchObject({
      alunno_id: ALU_A,
      section_id: SEZ_A,
      data: GIORNO,
      scuola_id: SEDE_A,
    })

    // Lo stato del database, non solo il payload.
    expect(h.db.presenze).toHaveLength(1)
    expect(h.db.presenze[0].scuola_id).toBe(SEDE_A)
  })

  it('sede della sezione non risolvibile: 500 e NESSUNA presenza scritta', async () => {
    // Il gate passa (prima lettura di `sections`), poi la lettura della sede si
    // rompe. PostgREST non lancia: ritorna `{ error }`. Senza controllarlo la
    // riga finirebbe in tabella con `scuola_id` NULL — cioè invisibile a
    // qualunque filtro per sede. La direzione sicura è rifiutare la scrittura.
    h.erroriSections = 1
    const res = await POST_APPELLO(
      post('http://localhost/api/primaria/appello', {
        sectionId: SEZ_A,
        data: GIORNO,
        records: [{ alunnoId: ALU_A, stato: 'presente' }],
      }),
    )
    expect(res.status).toBe(500)
    expect(scrittureSu('presenze', 'upsert')).toHaveLength(0)
    expect(h.db.presenze).toHaveLength(0)
  })
})

describe('POST /api/locker/inventory — il carico nasce con la sede dell\'alunno', () => {
  it('l\'insert porta scuola_id, e la riga in `armadietto` ce l\'ha', async () => {
    const res = await POST_CARICO(
      post('http://localhost/api/locker/inventory', {
        alunno_id: ALU_A,
        materiale: 'Pannolini',
        quantita: 3,
        date: GIORNO,
      }),
    )
    expect(res.status).toBe(200)

    const insert = scrittureSu('armadietto', 'insert')
    expect(insert).toHaveLength(1)
    expect(insert[0].valori[0]).toMatchObject({ alunno_id: ALU_A, scuola_id: SEDE_A })
    expect(h.db.armadietto).toHaveLength(1)
    expect(h.db.armadietto[0].scuola_id).toBe(SEDE_A)
  })

  it('alunno inesistente: 404 e nessuna riga di armadietto', async () => {
    const res = await POST_CARICO(
      post('http://localhost/api/locker/inventory', {
        alunno_id: '99999999-9999-4999-8999-999999999999',
        materiale: 'Pannolini',
        quantita: 3,
      }),
    )
    expect(res.status).toBe(404)
    expect(h.db.armadietto).toHaveLength(0)
  })
})

describe('PATCH /api/locker/inventory — il consumo nasce con la sede dell\'alunno', () => {
  it('l\'insert porta scuola_id, e la riga in `armadietto` ce l\'ha', async () => {
    const res = await PATCH_CONSUMO(
      new NextRequest('http://localhost/api/locker/inventory', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alunno_id: ALU_A, materiale: 'Pannolini', quantita_usata: 1 }),
      }),
    )
    expect(res.status).toBe(200)

    const insert = scrittureSu('armadietto', 'insert')
    expect(insert).toHaveLength(1)
    expect(insert[0].valori[0]).toMatchObject({ alunno_id: ALU_A, portato: false, scuola_id: SEDE_A })
    expect(h.db.armadietto).toHaveLength(1)
    expect(h.db.armadietto[0].scuola_id).toBe(SEDE_A)
  })
})

describe('POST /api/diary/entries — lo scalo del pannolino nasce con la sede', () => {
  it('l\'insert automatico su `armadietto` porta scuola_id', async () => {
    const res = await POST_DIARIO(
      post('http://localhost/api/diary/entries', {
        alunno_id: ALU_A,
        tipo_evento: 'bagno',
      }),
    )
    expect(res.status).toBe(200)

    const insert = scrittureSu('armadietto', 'insert')
    expect(insert).toHaveLength(1)
    expect(insert[0].valori[0]).toMatchObject({
      alunno_id: ALU_A,
      materiale: 'Pannolini',
      portato: false,
      scuola_id: SEDE_A,
    })
    expect(h.db.armadietto).toHaveLength(1)
    expect(h.db.armadietto[0].scuola_id).toBe(SEDE_A)
  })
})
