import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/incassi/storno — storno tracciato (slice S3):
//  (c) senza motivo → 400; storno = contro-incasso negativo metodo='storno'
//  collegato all'originale; 409 se già stornato o se è esso stesso uno storno.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  annulla: vi.fn(),
  orig: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/pagamenti/ricevute', () => ({ annullaRicevutaAttiva: (...a: unknown[]) => h.annulla(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'incassi' ? { data: h.orig, error: null } : { data: null, error: null })
      b.single = async () => ({ data: { id: `${table}-new` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/incassi/storno/route'

const INC = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/incassi/storno', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.annulla.mockResolvedValue(undefined)
  h.orig = { id: INC, pagamento_id: 'p-1', importo: 100, metodo: 'contanti', storno_di: null, stornato_il: null }
  h.inserts = []; h.updates = []
})

describe('POST storno incasso', () => {
  it('(c) senza motivo → 400', async () => {
    const res = await POST(post({ incasso_id: INC }))
    expect(res.status).toBe(400)
  })

  it('motivo troppo corto → 400', async () => {
    const res = await POST(post({ incasso_id: INC, motivo: 'x' }))
    expect(res.status).toBe(400)
  })

  it('storno valido → contro-incasso negativo metodo storno collegato', async () => {
    const res = await POST(post({ incasso_id: INC, motivo: 'errore di cassa' }))
    expect(res.status).toBe(200)
    const contro = h.inserts.find((i) => i.table === 'incassi')!.row as { importo: number; metodo: string; storno_di: string }
    expect(contro.importo).toBe(-100)
    expect(contro.metodo).toBe('storno')
    expect(contro.storno_di).toBe(INC)
  })

  it('409 se l\'incasso è già stornato', async () => {
    h.orig = { id: INC, pagamento_id: 'p-1', importo: 100, metodo: 'contanti', storno_di: null, stornato_il: '2026-07-18T10:00:00Z' }
    const res = await POST(post({ incasso_id: INC, motivo: 'errore di cassa' }))
    expect(res.status).toBe(409)
  })

  it('409 se è esso stesso uno storno (metodo storno)', async () => {
    h.orig = { id: INC, pagamento_id: 'p-1', importo: -100, metodo: 'storno', storno_di: 'altro', stornato_il: null }
    const res = await POST(post({ incasso_id: INC, motivo: 'errore di cassa' }))
    expect(res.status).toBe(409)
  })

  it('404 se l\'incasso non esiste', async () => {
    h.orig = null
    const res = await POST(post({ incasso_id: INC, motivo: 'errore di cassa' }))
    expect(res.status).toBe(404)
  })
})
