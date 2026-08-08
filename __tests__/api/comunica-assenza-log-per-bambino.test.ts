/**
 * T10 · T29 — «sta funzionando? per QUALE bambino? a quanti docenti è partito
 * l'avviso?» è la domanda per cui questa riga di log esiste. Dalla seconda
 * comunicazione dello stesso genitore nello stesso giorno in poi, non aveva più
 * risposta.
 *
 * `app_log` deduplica per `(fingerprint, giorno)` e non aggiorna il `contesto`
 * sull'`ON CONFLICT`: due POST riuscite su due bambini diversi lasciavano UNA
 * riga con `occorrenze=2` e `alunno_id`, `presenza_id`, `n_docenti` del solo
 * PRIMO. Il secondo bambino non compariva in nessuna riga della tabella — e
 * `riga_creata`, introdotto apposta per distinguere una comunicazione nuova da
 * una correzione, per costruzione non poteva mai valere `false` una volta che la
 * prima del giorno era stata una creazione.
 *
 * Le due correzioni sono complementari e questo file le misura entrambe:
 *  · `distingui: ['alunno_id', 'presenza_id']` porta l'identità della riga
 *    DENTRO l'impronta (il meccanismo è provato in
 *    `__tests__/logging/deduplica-per-bersaglio.test.ts`);
 *  · due `esito` distinti — `assenza-comunicata` / `assenza-aggiornata` — così la
 *    correzione smette di essere invisibile anche a chi legge la sola colonna
 *    `messaggio`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { resetRateLimit } from '@/lib/security/rate-limit'

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const MAESTRA = 'd1111111-1111-4111-8111-111111111111'
const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const DOMANI = '2026-08-11'

const h = vi.hoisted(() => ({ requireParent: vi.fn(), assertGenitore: vi.fn() }))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

let db: DBFinto
let scritture: Scrittura[]
let client: ReturnType<typeof creaFintoSupabase>

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => client }))

import { POST, DELETE } from '@/app/api/parent/presenze/comunica-assenza/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const deleteReq = (q: Record<string, string>) =>
  new NextRequest(
    `http://localhost/api/parent/presenze/comunica-assenza?${new URLSearchParams(q).toString()}`,
    { method: 'DELETE' },
  )

/** La chiamata a `logEvento` con quell'esito, con TUTTI i suoi argomenti. */
const rigaConEsito = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as Record<string, unknown>)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  resetRateLimit()
  db = {
    alunni: [{ id: STUDENT, nome: 'Sofia', cognome: 'Rossi', section_id: SEZIONE, scuola_id: SCUOLA }],
    sections: [{ id: SEZIONE, school_type: 'infanzia', scuola_id: SCUOLA }],
    utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZIONE }],
    utenti: [{ id: MAESTRA, attivo: true }],
    admin_settings: [],
    presenze: [],
    notifiche: [],
  }
  scritture = []
  client = creaFintoSupabase(db, [], { scritture })
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.assertGenitore.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T10 — la riga di successo dichiara di QUALE bambino parla', () => {
  it('la POST riuscita distingue la riga per alunno e per presenza', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    const riga = rigaConEsito('assenza-comunicata')
    expect(riga, 'il successo di un evento critico si logga (AGENTS.md, regola 5)').toBeTruthy()
    const opzioni = riga?.[4] as { distingui?: string[] } | undefined
    expect(
      opzioni?.distingui,
      'senza, due comunicazioni dello stesso genitore cadono in una riga sola con i dati della prima',
    ).toContain('alunno_id')
    expect(opzioni?.distingui).toContain('presenza_id')
  })

  it('la riga porta ancora il conteggio dei docenti avvisati', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    expect((rigaConEsito('assenza-comunicata')?.[2] as Record<string, unknown>)?.n_docenti).toBe(1)
  })

  it('il motivo dell’assenza NON compare in nessun log (dato sanitario di un minore)', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'varicella-marcatore' }))
    expect(JSON.stringify(logEvento.mock.calls)).not.toContain('varicella-marcatore')
  })

  it('anche l’annullamento distingue la riga per alunno e presenza', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    logEvento.mockClear()
    await DELETE(deleteReq({ studentId: STUDENT, data: DOMANI }))
    const riga = rigaConEsito('assenza-annullata')
    expect(riga).toBeTruthy()
    expect((riga?.[4] as { distingui?: string[] } | undefined)?.distingui).toContain('alunno_id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T29 — una correzione non è una comunicazione nuova, e si vede', () => {
  it('la prima volta l’esito è `assenza-comunicata`', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    expect(rigaConEsito('assenza-comunicata')).toBeTruthy()
    expect(rigaConEsito('assenza-aggiornata')).toBeFalsy()
  })

  it('la seconda volta sullo stesso giorno l’esito è `assenza-aggiornata`', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    logEvento.mockClear()
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita' }))
    expect(
      rigaConEsito('assenza-aggiornata'),
      '`riga_creata: false` non poteva mai comparire: la prima del giorno decideva il messaggio per tutte',
    ).toBeTruthy()
    expect(rigaConEsito('assenza-comunicata')).toBeFalsy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('il DELETE che non trova niente da annullare non resta muto', () => {
  it('«non c’era niente» lascia una riga, e non si confonde con «tutto ok»', async () => {
    const res = await DELETE(deleteReq({ studentId: STUDENT, data: DOMANI }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ annullata: false })
    expect(
      rigaConEsito('assenza-gia-assente'),
      '«nessun log» tornava a voler dire insieme «tutto ok» e «non c’era niente»',
    ).toBeTruthy()
  })
})
