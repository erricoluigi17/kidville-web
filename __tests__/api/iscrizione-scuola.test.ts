// @vitest-environment node
// Da quando il modulo pubblico mostra l'informativa al punto di raccolta, la
// presa visione è un consenso OBBLIGATORIO verificato server-side: senza,
// l'invio è un 400. I payload di prova la includono — l'oggetto di questi file
// è la risoluzione della sede e la validazione dei campi, non il consenso, che
// ha il suo test dedicato in `__tests__/api/iscrizione-consensi.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SEDE_A,
  SEDE_B,
  SEDE_C,
  NOME_SEDE_A,
  NOME_SEDE_B,
  NOME_SEDE_C,
  SEDE_E2E,
  NOME_SEDE_E2E,
} from '../fixtures/sedi'

/**
 * `POST /api/iscrizione` — risoluzione della SEDE.
 *
 * Il 400 «Specificare la scuola» è l'ultima difesa per chi invia fuori dal wizard:
 * con tre sedi reali NON deve diventare un default silenzioso, perché un'iscrizione
 * finita nel plesso sbagliato è peggio di un errore. Il predicato "scuola reale"
 * è condiviso con `GET /api/iscrizione/sedi` (`@/lib/scuole/reali`): questi test
 * bloccano anche quella condivisione.
 */

const h = vi.hoisted(() => ({
  schools: { data: [] as unknown, error: null as unknown },
  scuole: { data: [] as unknown, error: null as unknown },
  inserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      if (table === 'schools' || table === 'scuole') {
        const risultato = table === 'schools' ? h.schools : h.scuole
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(risultato).then(res, rej)
        return b
      }
      if (table === 'form_models') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: minimalModel, error: null })
        return b
      }
      // enrollment_submissions
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.select = () => b
      b.single = async () => ({ data: { id: 'sub-1' }, error: null })
      return b
    },
  }),
}))

// Modello minimale: un solo campo obbligatorio per bambino/adulto.
const minimalModel = {
  schema: {
    version: '1',
    pages: [
      { id: 'bambino', title: 'B', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
      { id: 'adulto', title: 'A', fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] },
    ],
  },
}

import { POST } from '@/app/api/iscrizione/route'

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }
const E2E = { id: SEDE_E2E, nome: NOME_SEDE_E2E }

const invia = (scuolaId?: string) =>
  POST(
    new Request('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scuola_id: scuolaId,
        data: { presa_visione_informativa: true, children: [{ nome: 'Tino' }], adults: [{ nome: 'Ines' }] },
      }),
    }) as unknown as import('next/server').NextRequest,
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.schools = { data: [], error: null }
  h.scuole = { data: [], error: null }
  h.inserts = []
})

describe('POST /api/iscrizione — risoluzione della sede', () => {
  it('UNA sola sede reale (+ la E2E) e nessuno scuola_id → 201 sulla sede reale (non-regressione)', async () => {
    h.schools = { data: [GAMMA, E2E], error: null }
    const res = await invia()
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(GAMMA.id)
  })

  it('TRE sedi reali e nessuno scuola_id → 400, nessun insert (niente default silenzioso)', async () => {
    h.schools = { data: [ALFA, BETA, GAMMA], error: null }
    const res = await invia()
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    const json = (await res.json()) as { error: string }
    expect(json.error).toContain('Specificare la scuola')
  })

  it('TRE sedi reali + scuola_id scelto dal wizard → 201 su QUELLA sede', async () => {
    h.schools = { data: [ALFA, BETA, GAMMA], error: null }
    const res = await invia(BETA.id)
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(BETA.id)
  })

  it('scuola_id inesistente → non viene usato: si ricade sulla risoluzione automatica', async () => {
    h.schools = { data: [GAMMA, E2E], error: null }
    const res = await invia('99999999-9999-4999-8999-999999999999')
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(GAMMA.id)
  })

  it('DB E2E della CI (solo la sede di test) → 201 su quella sede (degrado pulito)', async () => {
    h.schools = { data: [E2E], error: null }
    const res = await invia()
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(E2E.id)
  })

  it('scuola_id esplicito sulla sede E2E → resta accettato (i test E2E passano da lì)', async () => {
    h.schools = { data: [GAMMA, E2E], error: null }
    const res = await invia(E2E.id)
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(E2E.id)
  })

  it('due sedi reali di cui una DISATTIVATA → 201 sull\'unica ancora attiva', async () => {
    h.schools = { data: [ALFA, GAMMA], error: null }
    h.scuole = { data: [{ id: ALFA.id, attiva: false }], error: null }
    const res = await invia()
    expect(res.status).toBe(201)
    expect(h.inserts[0].scuola_id).toBe(GAMMA.id)
  })

  it('lettura di `schools` in errore → 400, nessun insert (non si indovina la sede)', async () => {
    h.schools = { data: null, error: { code: '42P01', message: 'relation "schools" does not exist' } }
    const res = await invia()
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
})
