import { it, expect, vi, beforeEach, describe } from 'vitest'

// GET /api/pagamenti/transazioni — registro + degradazione (slice S4).
//  (e) tabella pagamenti_transazioni assente (42P01/PGRST205) → { data: [], disponibile:false }.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  listResult: { data: [] as unknown, error: null as { code?: string } | null },
  // Tabelle lette per le colonne Sede e Pagante del registro (26/09). Il finto
  // FILTRA per id: un nome che torna è un nome che la route ha chiesto davvero.
  scuole: [] as { id: string; nome: string }[],
  parents: [] as { id: string; first_name: string; last_name: string }[],
  erroreParents: null as { code?: string } | null,
  erroreScuole: null as { code?: string } | null,
  eventi: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Il logger vero resta al suo posto; si registrano solo gli eventi, per vedere
// QUALE degradazione è stata segnalata.
vi.mock('@/lib/logging/logger', async (orig) => {
  const vero = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.eventi.push(a)
      return vero.logEvento(...a)
    },
  }
})
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: (...a: unknown[]) => h.scope(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.in = (_col: string, ids: string[]) => {
        if (table === 'scuole') {
          b.then = (r: (v: unknown) => unknown) =>
            r(h.erroreScuole ? { data: null, error: h.erroreScuole } : { data: h.scuole.filter((x) => ids.includes(x.id)), error: null })
        }
        if (table === 'parents') {
          b.then = (r: (v: unknown) => unknown) =>
            r(h.erroreParents ? { data: null, error: h.erroreParents } : { data: h.parents.filter((x) => ids.includes(x.id)), error: null })
        }
        return b
      }
      b.eq = () => b
      b.order = () => b
      b.limit = async () => h.listResult
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/transazioni/route'

const SC = '22222222-2222-4222-8222-222222222222'
const get = () => new Request('http://localhost/api/pagamenti/transazioni', { headers: { 'x-user-id': 'seg-1' } })

const SC_B = '44444444-4444-4444-8444-444444444444'
const PAR = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  h.scuole = [
    { id: SC, nome: 'Kidville Alfa' },
    { id: SC_B, nome: 'Kidville Beta' },
  ]
  h.parents = [{ id: PAR, first_name: 'Anna', last_name: 'Rossi' }]
  h.erroreParents = null
  h.erroreScuole = null
  h.eventi = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
})

describe('GET transazioni — degradazione', () => {
  it('(e) tabella assente (42P01) → { data: [], disponibile:false }', async () => {
    h.listResult = { data: null, error: { code: '42P01' } }
    const res = await GET(get() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.disponibile).toBe(false)
  })

  it('(e-bis) tabella assente (PGRST205) → degrada', async () => {
    h.listResult = { data: null, error: { code: 'PGRST205' } }
    const res = await GET(get() as never)
    const j = await res.json()
    expect(j.disponibile).toBe(false)
  })

  it('tabella presente → data e disponibile:true', async () => {
    h.listResult = { data: [{ id: 'tx-1', importo_totale: 100 }], error: null }
    const res = await GET(get() as never)
    const j = await res.json()
    expect(j.disponibile).toBe(true)
    expect(j.data).toHaveLength(1)
  })
})

describe('GET transazioni — colonne Sede e Pagante', () => {
  it('ogni riga porta scuola_nome e pagante_nome (nome e cognome del genitore)', async () => {
    h.scope.mockResolvedValue([SC, SC_B])
    h.listResult = {
      data: [
        { id: 'tx-1', scuola_id: SC, pagante_parent_id: PAR, importo_totale: 100 },
        { id: 'tx-2', scuola_id: SC_B, pagante_parent_id: PAR, importo_totale: 50 },
      ],
      error: null,
    }
    const res = await GET(get() as never)
    const j = await res.json()
    expect(j.data.map((r: { scuola_nome: string }) => r.scuola_nome)).toEqual(['Kidville Alfa', 'Kidville Beta'])
    expect(j.data.map((r: { pagante_nome: string }) => r.pagante_nome)).toEqual(['Anna Rossi', 'Anna Rossi'])
  })

  it('lettura dei genitori fallita ⇒ il registro resta leggibile, pagante_nome null', async () => {
    h.erroreParents = { code: '42501' }
    h.listResult = { data: [{ id: 'tx-1', scuola_id: SC, pagante_parent_id: PAR, importo_totale: 100 }], error: null }
    const res = await GET(get() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].pagante_nome).toBeNull()
    expect(j.data[0].scuola_nome).toBe('Kidville Alfa')
    // La degradazione è segnalata, una volta, a livello warn: senza, il ramo
    // sarebbe un catch muto (regola 6 di AGENTS.md).
    const warn = h.eventi.filter((e) => (e[2] as { esito?: string }).esito === 'paganti-non-letti')
    expect(warn).toHaveLength(1)
    expect(warn[0][1]).toBe('warn')
  })

  it('lettura delle sedi fallita ⇒ il registro resta leggibile, scuola_nome null, pagante_nome ancora valorizzato', async () => {
    h.erroreScuole = { code: '42501' }
    h.listResult = { data: [{ id: 'tx-1', scuola_id: SC, pagante_parent_id: PAR, importo_totale: 100 }], error: null }
    const res = await GET(get() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.disponibile).toBe(true)
    expect(j.data[0].scuola_nome).toBeNull()
    expect(j.data[0].pagante_nome).toBe('Anna Rossi')
    // La degradazione è segnalata, una volta, a livello warn.
    const warn = h.eventi.filter((e) => (e[2] as { esito?: string }).esito === 'nomi-sede-non-letti')
    expect(warn).toHaveLength(1)
    expect(warn[0][1]).toBe('warn')
  })
})
