import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET /api/pagamenti` — LA PROIEZIONE DELLA VESTE DI FAMIGLIA, CHE NESSUN TEST
 * VERIFICAVA.
 *
 * Chi guarda in veste di famiglia non vede i CONTAINER rateali (`tipo: 'padre'`):
 * vede le rate figlie, una per una, con la propria scadenza. È una PROIEZIONE della
 * schermata — non un permesso — e chi guarda in veste di lavoro deve continuare a
 * vedere il prospetto intero, che è ciò che gli serve per riconciliare.
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE (2026-09-01). Convertendo la riga da
 * `user.role === 'genitore'` ad `agisceComeGenitore(user)` si è provato a
 * FALSIFICARLA, invertendola apposta. `pagamenti-filtri`, `pagamenti-scope-vuoto` e
 * `pagamenti-legame-anagrafica` insieme — dieci test — sono rimasti tutti VERDI con
 * la proiezione ROVESCIATA: cioè con la famiglia che si vede i container e
 * l'operatrice che se li perde. Una riga mai vista fallire non è coperta, e questa
 * decide cosa una madre legge nella schermata dei pagamenti.
 *
 * Le due asserzioni qui sotto sono state verificate contro quella mutazione:
 * invertendo la condizione diventano rosse entrambe.
 */

const PADRE = 'p0000000-0000-4000-8000-00000000000a'
const RATA = 'r0000000-0000-4000-8000-00000000000b'
const ALU = 'a0000000-0000-4000-8000-00000000000c'

const h = vi.hoisted(() => ({
  utente: { id: 'u1', role: 'segreteria' as string, scuola_id: null as string | null },
  /** Le righe che il finto client restituisce per la tabella `pagamenti`. */
  pagamenti: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
  requireStaff: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: vi.fn(async () => [ALU]),
}))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'eq', 'in', 'or', 'gte', 'lte']) b[m] = () => b
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'pagamenti' ? h.pagamenti : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'

const req = () =>
  new Request('http://localhost/api/pagamenti') as unknown as import('next/server').NextRequest

const idsDi = async (res: Response) =>
  ((await res.json()).data as Array<{ id: string }>).map((r) => r.id)

beforeEach(() => {
  h.utente = { id: 'u1', role: 'segreteria', scuola_id: null }
  h.pagamenti = [
    // Il container rateale e una sua rata: la coppia su cui la proiezione si vede.
    { id: PADRE, alunno_id: ALU, tipo: 'padre', importo: 900, stato: 'da_pagare', scadenza: '2026-09-30' },
    { id: RATA, alunno_id: ALU, tipo: 'rata', parent_id: PADRE, importo: 300, stato: 'da_pagare', scadenza: '2026-09-30' },
  ]
})

describe('GET /api/pagamenti — la proiezione della veste di famiglia', () => {
  it('in veste di famiglia il container rateale è nascosto, la rata resta', async () => {
    h.utente = { id: 'gen1', role: 'genitore', scuola_id: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const ids = await idsDi(res)
    expect(ids, 'un totale di 900 accanto alla rata da 300 è la stessa somma contata due volte').not.toContain(PADRE)
    expect(ids).toContain(RATA)
  })

  it('in veste di lavoro il prospetto resta intero: container E rata', async () => {
    // È la metà che si perde scambiando il predicato, e senza la quale la
    // segreteria non riconcilia più niente.
    const res = await GET(req())
    expect(res.status).toBe(200)
    const ids = await idsDi(res)
    expect(ids).toContain(PADRE)
    expect(ids).toContain(RATA)
  })
})
