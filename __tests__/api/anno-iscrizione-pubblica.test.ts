// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { STANDARD_ENROLLMENT_MODEL_ID } from '@/lib/forms/enrollment-default-schema'

/**
 * Compito 3.5-2 · `POST /api/iscrizione` (il modulo pubblico) dichiara l'anno della domanda.
 *
 * Database finto che applica i filtri e le scritture; `annoPerScritturaPubblica` è quello vero. La porta
 * non ha utente, quindi niente cookie, niente gettone e niente rifiuto: se l'anno non si può leggere la
 * domanda si scrive lo stesso, senza `anno_id`. `anno_id` è `anni_scolastici.id` (`a2…` = `corrente`).
 * Nessun orologio congelato; uuid e dati finti (nessun dato di una famiglia vera).
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
  // errore da restituire alla N-esima chiamata di `insert` su `enrollment_submissions` (0 = la prima)
  erroriInsert: [] as ({ code: string; message?: string } | null)[],
  chiamateInsert: 0,
  scritture: [] as unknown[],
  logEvento: vi.fn(),
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, [], { errori: h.errori, scritture: h.scritture as Scrittura[] })
    return {
      from(tabella: string) {
        const b = vero.from(tabella)
        if (tabella !== 'enrollment_submissions') return b
        return {
          insert(riga: Riga) {
            const errore = h.erroriInsert[h.chiamateInsert++] ?? null
            if (!errore) return b.insert(riga)
            return { select: () => ({ single: async () => ({ data: null, error: errore }) }) }
          },
        }
      },
    }
  },
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})

import { POST } from '@/app/api/iscrizione/route'

// `anni_scolastici.id`
const A2 = 'a2222222-2222-4222-8222-222222222222' // corrente
const A3 = 'a3333333-3333-4333-8333-333333333333' // in_preparazione
const A9 = 'a9999999-9999-4999-8999-999999999999' // un altro anno, nel cookie
// `anni_sede.id`
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'

const modello = {
  id: STANDARD_ENROLLMENT_MODEL_ID,
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
      { id: 'adulto', title: 'A', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
    ],
  },
}

const invia = (scuolaId?: string, cookie?: string) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({
        scuola_id: scuolaId,
        data: { presa_visione_informativa: true, children: [{ nome: 'Tino' }], adults: [{ nome: 'Ines' }] },
      }),
    }),
  )

const inserimenti = () =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === 'enrollment_submissions' && s.operazione === 'insert')
const erroriAnno = () => h.logEvento.mock.calls.filter((c) => c[0] === 'anno-scolastico' && c[1] === 'error')
const warnAnno = () => h.logEvento.mock.calls.filter((c) => c[0] === 'anno-scolastico' && c[1] === 'warn')

beforeEach(() => {
  h.errori = {}
  h.erroriInsert = []
  h.chiamateInsert = 0
  h.scritture = []
  h.logEvento.mockClear()
  h.db = {
    schools: [{ id: SEDE_A, nome: 'Sede Alfa' }],
    form_models: [modello],
    enrollment_submissions: [],
    anni_sede: [
      { id: S2, scuola_id: SEDE_A, anno_id: A2, stato: 'corrente', domande_aperte: false },
      { id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: true },
    ],
  }
})

describe('POST /api/iscrizione · l\'anno della domanda', () => {
  it('la domanda nasce con l\'anno del `corrente`, e non legge il cookie (a)', async () => {
    const res = await invia(undefined, `anno_attivo=${A9}`)
    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).toMatchObject({ scuola_id: SEDE_A, anno_id: A2 })
    expect(JSON.stringify(inserimenti()[0].valori[0])).not.toContain(A9)
  })

  it('le due strade (primo tentativo e ripiego PGRST204) scrivono lo stesso anno_id', async () => {
    const dritta = await invia()
    expect(dritta.status).toBe(201)
    const annoDritta = inserimenti()[0].valori[0].anno_id

    h.scritture = []
    h.chiamateInsert = 0
    h.erroriInsert = [{ code: 'PGRST204', message: 'colonna consents_log assente' }]
    const ripiego = await invia()
    expect(ripiego.status).toBe(201)
    // l'insert del primo tentativo è stato respinto: resta quello di ripiego, senza `consents_log`
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('consents_log')
    expect(inserimenti()[0].valori[0].anno_id).toBe(A2)
    expect(inserimenti()[0].valori[0].anno_id).toBe(annoDritta)
  })

  it('con `anni_sede` che risponde PGRST205 la riga NON ha anno_id e la risposta è 201 (b)', async () => {
    h.errori = { anni_sede: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await invia()
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
  })

  it('PGRST205 vale anche per il ripiego: nessuno dei due scrive anno_id', async () => {
    h.errori = { anni_sede: { code: 'PGRST205' } }
    h.erroriInsert = [{ code: '42703' }]
    const res = await invia()
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
  })

  it('una lettura di `anni_sede` in errore vero (57014): la domanda si scrive lo stesso, senza anno_id, con UNA riga error', async () => {
    h.errori = { anni_sede: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await invia()
    expect(res.status).toBe(201)
    expect(inserimenti()).toHaveLength(1)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
    expect(erroriAnno()).toHaveLength(1)
  })

  it('senza un `corrente` (agosto) la domanda si scrive senza anno_id, con un warn', async () => {
    h.db.anni_sede = [{ id: S3, scuola_id: SEDE_A, anno_id: A3, stato: 'in_preparazione', domande_aperte: true }]
    const res = await invia()
    expect(res.status).toBe(201)
    expect(inserimenti()[0].valori[0]).not.toHaveProperty('anno_id')
    expect(warnAnno().length).toBeGreaterThanOrEqual(1)
    expect(erroriAnno()).toHaveLength(0)
  })

  it('se l\'insert risponde ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO (c)', async () => {
    h.erroriInsert = [{ code: 'P0001', message: 'ANNO_CHIUSO' }]
    const res = await invia()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('se è il ripiego a rispondere ANNO_CHIUSO la risposta è 409 ANNO_CHIUSO (c)', async () => {
    h.erroriInsert = [{ code: 'PGRST204' }, { code: 'P0001', message: 'ANNO_CHIUSO' }]
    const res = await invia()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('con più sedi reali e nessuna indicata resta 400, come oggi, e non scrive (d)', async () => {
    h.db.schools = [
      { id: SEDE_A, nome: 'Sede Alfa' },
      { id: SEDE_B, nome: 'Sede Beta' },
    ]
    const res = await invia()
    expect(res.status).toBe(400)
    expect(inserimenti()).toHaveLength(0)
  })
})
