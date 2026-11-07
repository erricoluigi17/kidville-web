// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * Compito 3.5-2 · `POST /api/forms/send-otp` scrive la sede della compilazione.
 *
 * La `form_submissions` di questa route nasceva SENZA `scuola_id`; la sorella `forms/submit` la risolve con
 * `risolviSedeCompilazione` (utente → modello → unica sede reale). Qui si riusa la stessa regola. La tabella
 * è in modo `data`: l'anno lo calcola il database dalla sede, quindi la route NON scrive `anno_id`.
 * Database finto che applica filtri e scritture; uuid finti, nessun dato di una famiglia vera.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  // se vero, l'insert che porta `scuola_id` risponde PGRST204 (DB della CI non migrato)
  sedeAssenteNelDb: false,
  // errore da restituire alla N-esima chiamata di `insert` su `form_submissions` (0 = la prima)
  erroriInsert: [] as ({ code: string; message?: string } | null)[],
  chiamateInsert: 0,
  scritture: [] as unknown[],
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  invioEmail: vi.fn(),
  GENITORE: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11',
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    return {
      from(tabella: string) {
        const b = vero.from(tabella)
        if (tabella !== 'form_submissions') return b
        return {
          ...b,
          insert(riga: Riga) {
            const guasto = h.erroriInsert[h.chiamateInsert++] ?? null
            if (guasto) return { select: () => ({ single: async () => ({ data: null, error: guasto }) }) }
            if (h.sedeAssenteNelDb && 'scuola_id' in riga) {
              return { select: () => ({ single: async () => ({ data: null, error: { code: 'PGRST204', message: 'colonna assente' } }) }) }
            }
            return b.insert(riga)
          },
          update: (v: Riga) => b.update(v),
        }
      },
    }
  },
}))
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
  sendEmailDetailed: (...a: unknown[]) => {
    h.invioEmail(...a)
    return Promise.resolve({ ok: true, error: null })
  },
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: { id: h.GENITORE, role: 'genitore', scuola_id: null } })),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 7, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn(async () => null),
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn(async () => null),
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { POST } from '@/app/api/forms/send-otp/route'

const MODELLO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10'

const invia = () =>
  POST(
    new Request('http://localhost/api/forms/send-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: MODELLO, userId: h.GENITORE, data: {} }),
    }),
  )

const inserimenti = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'form_submissions' && s.operazione === 'insert')
const avvisiSede = () =>
  h.logEvento.mock.calls.filter((c) => c[1] === 'warn' && c[2]?.esito === 'compilazione-senza-sede')

beforeEach(() => {
  h.errori = {}
  h.sedeAssenteNelDb = false
  h.erroriInsert = []
  h.chiamateInsert = 0
  h.invioEmail.mockClear()
  h.logErrore.mockClear()
  h.scritture = []
  h.logEvento.mockClear()
  h.db = {
    form_models: [{ id: MODELLO, schema: { version: '1', pages: [] }, scuola_id: SEDE_B }],
    form_submissions: [],
    utenti: [{ id: h.GENITORE, email: 'genitore@example.test', scuola_id: SEDE_A }],
    schools: [{ id: SEDE_A, nome: 'Sede Alfa' }],
  }
})

describe('POST /api/forms/send-otp · la sede della compilazione', () => {
  it('la riga nasce con la sede dell\'utente, prima di quella del modello', async () => {
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, model_id: MODELLO })
    expect(avvisiSede()).toHaveLength(0)
  })

  it('utente senza sede e modello con sede → la sede del modello', async () => {
    h.db.utenti = [{ id: h.GENITORE, email: 'genitore@example.test', scuola_id: null }]
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('l\'anno non lo scrive la route: la tabella è in modo `data`', async () => {
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
  })

  it('nessuna sede (né utente, né modello, né una sede reale sola): la riga nasce senza scuola_id, con un warn', async () => {
    h.db.utenti = [{ id: h.GENITORE, email: 'genitore@example.test', scuola_id: null }]
    h.db.form_models = [{ id: MODELLO, schema: { version: '1', pages: [] }, scuola_id: null }]
    h.db.schools = []
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('scuola_id')
    expect(avvisiSede()).toHaveLength(1)
    // solo uuid e codice: nessun dato di una persona
    expect(avvisiSede()[0][2]).toMatchObject({ entita_id: MODELLO, error_code: 'SEDE_NON_DETERMINABILE' })
  })

  it('più sedi reali e nessuna indicata: non si indovina, la riga nasce senza scuola_id, con un warn', async () => {
    h.db.utenti = [{ id: h.GENITORE, email: 'genitore@example.test', scuola_id: null }]
    h.db.form_models = [{ id: MODELLO, schema: { version: '1', pages: [] }, scuola_id: null }]
    h.db.schools = [
      { id: SEDE_A, nome: 'Sede Alfa' },
      { id: SEDE_B, nome: 'Sede Beta' },
    ]
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('scuola_id')
    expect(avvisiSede()).toHaveLength(1)
  })

  it('PGRST204 su scuola_id (DB della CI non migrato): si riscrive senza, e la richiesta riesce', async () => {
    h.sedeAssenteNelDb = true
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('scuola_id')
  })

  it('un guasto vero dell\'insert resta un 500, non un degrado', async () => {
    h.errori = { 'form_submissions:insert': { code: '57014', message: 'timeout' } }
    const res = await invia()
    expect(res.status).toBe(500)
  })

  it('(c) ANNO_CHIUSO sull\'insert → 409 ANNO_CHIUSO, nessuna OTP inviata', async () => {
    h.erroriInsert = [{ code: 'P0001', message: 'ANNO_CHIUSO' }]
    const res = await invia()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(h.invioEmail).not.toHaveBeenCalled()
  })

  it('(c) ANNO_CHIUSO sull\'insert di ripiego (dopo PGRST204) → 409 ANNO_CHIUSO', async () => {
    h.erroriInsert = [{ code: 'PGRST204' }, { code: 'P0001', message: 'ANNO_CHIUSO' }]
    const res = await invia()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(h.invioEmail).not.toHaveBeenCalled()
  })

  it('GIORNO_SENZA_ANNO sul primo insert: si riscrive senza scuola_id, la richiesta riesce, UNA riga error', async () => {
    h.erroriInsert = [{ code: 'P0001', message: 'GIORNO_SENZA_ANNO' }]
    const res = await invia()
    expect(res.status).toBe(200)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('scuola_id')
    const errori = [
      ...h.logErrore.mock.calls,
      ...h.logEvento.mock.calls.filter((c) => c[1] === 'error'),
    ]
    expect(errori).toHaveLength(1)
    expect(h.invioEmail).toHaveBeenCalled()
  })
})
