import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/ticket?alunno_id — LO STAFF VEDE SOLO I BAMBINI DEI SUOI PLESSI (K5).
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 * Il ramo del genitore controllava il legame col figlio; quello dello STAFF non controllava
 * niente: una segreteria di Aversa, con l'uuid di un bambino di Cesa, ne leggeva saldo ticket
 * e data dell'ultima ricarica. Il client è service-role, quindi la RLS non c'è: il gate
 * applicativo è l'unico presidio.
 *
 * Qui `assertAlunnoInScope` è quella VERA (nessun mock di `@/lib/auth/scope`): il finto è il
 * solo database. Togliere la chiamata dalla route fa diventare rosso il primo test.
 *
 * Gli uuid sono INVENTATI: nessuno è di una sede o di un bambino veri.
 */

const SEDE_A = '11111111-2222-4333-8444-5555555555a1'
const SEDE_B = '11111111-2222-4333-8444-5555555555b2'
const ALUNNO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  logErrore: vi.fn(),
  /** L'alunno com'è a database (sede e sezione), o null se non esiste. */
  alunno: null as Record<string, unknown> | null,
  alunnoErrore: null as { code: string; message: string } | null,
  ticket: null as Record<string, unknown> | null,
  ticketErrore: null as { code: string; message: string } | null,
  letture: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireStaff: h.requireUser }))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: (...a: unknown[]) => h.genitoreHasFiglio(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      h.letture.push(table)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => {
        if (table === 'alunni') return { data: h.alunnoErrore ? null : h.alunno, error: h.alunnoErrore }
        if (table === 'ticket_mensa') return { data: h.ticketErrore ? null : h.ticket, error: h.ticketErrore }
        return { data: null, error: null }
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ticket/route'

const get = () => GET(new Request(`http://localhost/api/pagamenti/ticket?alunno_id=${ALUNNO}`))

beforeEach(() => {
  vi.clearAllMocks()
  h.letture = []
  h.alunno = { id: ALUNNO, section_id: 'sez-1', scuola_id: SEDE_B }
  h.alunnoErrore = null
  h.ticket = { alunno_id: ALUNNO, saldo_ticket: 7, ultimo_carico: '2026-09-01T08:00:00Z' }
  h.ticketErrore = null
  h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.genitoreHasFiglio.mockResolvedValue(true)
})

describe('staff', () => {
  it('alunno di un ALTRO plesso → 403, e il saldo non viene nemmeno letto', async () => {
    const res = await get()
    expect(res.status).toBe(403)
    expect(h.letture).not.toContain('ticket_mensa')
  })

  it('alunno del proprio plesso → 200 col saldo', async () => {
    h.alunno = { ...h.alunno, scuola_id: SEDE_A }
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ alunno_id: ALUNNO, saldo_ticket: 7 })
  })

  it.each(['admin', 'coordinator'])('%s fuori plesso → 403 (non solo la segreteria)', async (role) => {
    h.requireUser.mockResolvedValue({ user: { id: 'staff-2', role, scuola_id: SEDE_A } })
    // L'admin passa da `utenti_scuole`: il finto non ne restituisce, quindi resta la primaria.
    const res = await get()
    expect(res.status).toBe(403)
    expect(h.letture).not.toContain('ticket_mensa')
  })

  it('alunno inesistente → 404, non un saldo zero inventato', async () => {
    h.alunno = null
    const res = await get()
    expect(res.status).toBe(404)
    expect(h.letture).not.toContain('ticket_mensa')
  })

  it('lettura dell’alunno fallita → non è un permesso: nessun saldo', async () => {
    h.alunnoErrore = { code: 'XX000', message: 'boom' }
    const res = await get()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(h.letture).not.toContain('ticket_mensa')
  })

  it('lo staff non passa dal legame di famiglia', async () => {
    h.alunno = { ...h.alunno, scuola_id: SEDE_A }
    await get()
    expect(h.genitoreHasFiglio).not.toHaveBeenCalled()
  })
})

describe('genitore — il ramo resta com’era', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'parent', scuola_id: SEDE_A } })
  })

  it('figlio proprio → 200, senza passare dallo scope di sede', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(h.genitoreHasFiglio).toHaveBeenCalledWith(expect.anything(), 'gen-1', ALUNNO)
    expect(h.letture).not.toContain('alunni')
  })

  it('non è suo figlio → 403', async () => {
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await get()
    expect(res.status).toBe(403)
    expect(h.letture).not.toContain('ticket_mensa')
  })
})

describe('PostgREST non lancia: l’errore sul saldo non diventa «saldo 0»', () => {
  it('SELECT su ticket_mensa fallita → 500 loggato, mai il saldo di ripiego', async () => {
    h.alunno = { ...h.alunno, scuola_id: SEDE_A }
    h.ticketErrore = { code: 'XX000', message: 'boom' }
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('nessuna riga (mai ricaricato) → saldo 0, che è un dato vero', async () => {
    h.alunno = { ...h.alunno, scuola_id: SEDE_A }
    h.ticket = null
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ alunno_id: ALUNNO, saldo_ticket: 0, ultimo_carico: null })
  })
})
