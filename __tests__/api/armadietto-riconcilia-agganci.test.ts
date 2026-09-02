import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// Armadietto — il motore delle richieste agganciato alle scritture
//
// `riconciliaRichieste` esisteva ma non la chiamava nessuno: lo stock scendeva
// sotto soglia e nessuna richiesta si apriva. Qui si prova l'aggancio sul
// CARICO, e — piu' importante — che la riconciliazione NON possa far fallire il
// movimento: il carico e' il dato, la richiesta e' la conseguenza.
// =============================================================================

const h = vi.hoisted(() => ({ riconcilia: vi.fn(), requireParent: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: h.riconcilia }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
// Il modulo e' `scrittura` al SINGOLARE (`src/lib/audit/scrittura.ts`): con il
// plurale vitest non risolve il path e il mock non aggancia niente.
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig() as object), logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'insert', 'update']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({ data: { section_id: 's1', scuola_id: 'sc1' }, error: null })
      qb.single = () => Promise.resolve({ data: { id: 'mov1' }, error: null })
      return qb
    },
  }),
}))

import { POST } from '@/app/api/locker/inventory/route'

const body = { alunno_id: '11111111-1111-1111-1111-111111111111', materiale: 'Pannolini', quantita: 30 }
function req() {
  return new Request('http://localhost/api/locker/inventory', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParent.mockResolvedValue({ user: { id: 'p1', role: 'parent' } })
  h.riconcilia.mockResolvedValue({ aperte: 0, aggiornate: 0, evase: 1 })
})

describe('il carico riconcilia le richieste', () => {
  it('dopo un carico riuscito chiama riconciliaRichieste per quell alunno', async () => {
    const res = await POST(req() as never)
    expect(res.status).toBe(200)
    expect(h.riconcilia).toHaveBeenCalledWith(expect.anything(), { alunnoId: body.alunno_id })
  })

  it('se la riconciliazione esplode il CARICO resta salvo, e resta una riga di log', async () => {
    // Il carico e' il dato, la richiesta e' la conseguenza: la conseguenza non
    // puo' far fallire il dato.
    h.riconcilia.mockRejectedValue(new Error('boom'))
    const res = await POST(req() as never)
    expect(res.status).toBe(200)
    expect(h.logErrore).toHaveBeenCalled()
  })
})
