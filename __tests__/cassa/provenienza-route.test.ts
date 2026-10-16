import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const CATEGORIA = 'ca000000-0000-4000-8000-000000000001'
const SPESA = 'ca000000-0000-4000-8000-000000000002'
const h = vi.hoisted(() => ({
  categoria: { data: null, error: null } as { data: unknown; error: unknown },
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  logErrore: vi.fn(), logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: async () => ({ user: { id: 'operatore', role: 'admin' } }) }))
vi.mock('@/lib/auth/scope', async (originale) => ({
  ...await originale<typeof import('@/lib/auth/scope')>(),
  resolveScuolaScrittura: async () => ({ scuolaId: SEDE_A }),
}))
vi.mock('@/lib/cassa/notifiche', () => ({ notificaUscitaNonAdmin: vi.fn(), verificaSogliaCassa: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logOk: vi.fn(), logErrore: h.logErrore, logEvento: h.logEvento }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({
  from(table: string) {
    let row: Record<string, unknown> = {}
    const b = {
      select: () => b, eq: () => b,
      insert: (r: Record<string, unknown>) => { row = r; h.inserts.push({ table, row }); return b },
      maybeSingle: async () => h.categoria,
      single: async () => ({ data: { id: 'movimento', ...row }, error: null }),
      then: (resolve: (x: unknown) => unknown) => resolve({ data: null, error: null }),
    }
    return b
  },
}) }))

import { POST } from '@/app/api/pagamenti/cassa/movimenti/route'

const richiesta = (extra: Record<string, unknown> = {}) => new Request('http://localhost/api/pagamenti/cassa/movimenti', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scuola_id: SEDE_A, tipo: 'uscita', importo: 20, categoria_id: SPESA, ...extra }),
})

beforeEach(() => { h.inserts = []; h.categoria = { data: { id: CATEGORIA, scuola_id: SEDE_A, attivo: true }, error: null }; vi.clearAllMocks() })

describe('Provenienza dei movimenti di cassa', () => {
  it('rifiuta una uscita senza scelta esplicita della cassa', async () => {
    const r = await POST(richiesta())
    expect(r.status).toBe(400)
    expect((await r.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'cassa_categoria_id' })]))
    expect(h.inserts).toHaveLength(0)
  })
  it('consente la scelta esplicita della cassa generale', async () => {
    expect((await POST(richiesta({ cassa_categoria_id: null }))).status).toBe(201)
    expect(h.inserts.find((i) => i.table === 'cassa_movimenti')?.row).toMatchObject({ cassa_categoria_id: null, scuola_id: SEDE_A })
  })
  it.each([SEDE_A, null])('salva la cassa categoria della sede o globale (%s)', async (scuola_id) => {
    h.categoria.data = { id: CATEGORIA, scuola_id, attivo: true }
    expect((await POST(richiesta({ cassa_categoria_id: CATEGORIA }))).status).toBe(201)
    expect(h.inserts[0].row.cassa_categoria_id).toBe(CATEGORIA)
  })
  it.each([
    { id: CATEGORIA, scuola_id: SEDE_B, attivo: true },
    { id: CATEGORIA, scuola_id: SEDE_A, attivo: false },
    null,
  ])('rifiuta una cassa di altra sede, disattivata o inesistente', async (categoria) => {
    h.categoria.data = categoria
    expect((await POST(richiesta({ cassa_categoria_id: CATEGORIA }))).status).toBe(400)
    expect(h.inserts).toHaveLength(0)
    expect(h.logEvento).toHaveBeenCalled()
  })
  it('un errore di lettura della categoria non diventa cassa generale', async () => {
    h.categoria = { data: null, error: { code: '08006' } }
    expect((await POST(richiesta({ cassa_categoria_id: CATEGORIA }))).status).toBe(500)
    expect(h.inserts).toHaveLength(0)
    expect(h.logErrore).toHaveBeenCalled()
  })
})
