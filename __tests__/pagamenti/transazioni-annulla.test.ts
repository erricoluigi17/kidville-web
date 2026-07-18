import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/transazioni/[id]/annulla — annullo tracciato (slice S4).
//  (f) senza motivo → 400; doppio annullo → 409;
//  storno di ogni incasso collegato + storno dell'eccedenza a credito;
//  se il credito è già stato speso (saldo < eccedenza) → 409 senza toccare nulla.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  storno: vi.fn(),
  saldo: vi.fn(),
  revoca: vi.fn(),
  annullaRic: vi.fn(),
  tx: null as Record<string, unknown> | null,
  incassi: [] as Record<string, unknown>[],
  eccedenzaRows: [] as { importo: number }[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/app/api/pagamenti/incassi/storno/route', () => ({ eseguiStornoIncasso: (...a: unknown[]) => h.storno(...a) }))
vi.mock('@/lib/pagamenti/credito', () => ({ saldoCredito: (...a: unknown[]) => h.saldo(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
vi.mock('@/lib/pagamenti/ricevute', () => ({ annullaRicevutaTransazioneAttiva: (...a: unknown[]) => h.annullaRic(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.maybeSingle = async () => (table === 'pagamenti_transazioni' ? { data: h.tx, error: null } : { data: null, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (b._op === 'insert' || b._op === 'update') return resolve({ data: null, error: null })
        if (table === 'incassi') return resolve({ data: h.incassi, error: null })
        if (table === 'crediti_famiglia') return resolve({ data: h.eccedenzaRows, error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/transazioni/[id]/annulla/route'

const SC = '22222222-2222-4222-8222-222222222222'
const PARENT = '33333333-3333-4333-8333-333333333333'
const TX = '77777777-7777-4777-8777-777777777777'
const ctx = { params: Promise.resolve({ id: TX }) }
const post = (body: unknown) =>
  new Request(`http://localhost/api/pagamenti/transazioni/${TX}/annulla`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.storno.mockResolvedValue({ status: 200, body: { success: true } })
  h.saldo.mockResolvedValue(100)
  h.revoca.mockResolvedValue({ revocati: [] })
  h.annullaRic.mockResolvedValue(undefined)
  h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: null }
  h.incassi = [
    { id: 'inc-1', importo: 100, metodo: 'bonifico', stornato_il: null, transazione_id: TX },
    { id: 'inc-2', importo: 100, metodo: 'bonifico', stornato_il: null, transazione_id: TX },
  ]
  h.eccedenzaRows = []
  h.inserts = []; h.updates = []
})

describe('POST annulla transazione', () => {
  it('(f) senza motivo → 400', async () => {
    const res = await POST(post({}), ctx)
    expect(res.status).toBe(400)
  })

  it('(f) motivo troppo corto → 400', async () => {
    const res = await POST(post({ motivo: 'x' }), ctx)
    expect(res.status).toBe(400)
  })

  it('annullo valido → storna ogni incasso collegato e marca la transazione', async () => {
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(200)
    expect(h.storno).toHaveBeenCalledTimes(2)
    const upd = h.updates.find((u) => u.table === 'pagamenti_transazioni')!.row as { annullata_il: string; annullo_motivo: string }
    expect(upd.annullo_motivo).toBe('errore di registrazione')
    expect(upd.annullata_il).toBeTruthy()
    expect(h.annullaRic).toHaveBeenCalledTimes(1)
  })

  it('(f) doppio annullo → 409', async () => {
    h.tx = { id: TX, scuola_id: SC, pagante_parent_id: PARENT, importo_totale: 200, annullata_il: '2026-07-18T10:00:00Z' }
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.storno).not.toHaveBeenCalled()
  })

  it('eccedenza a credito già speso (saldo < eccedenza) → 409 senza stornare nulla', async () => {
    h.eccedenzaRows = [{ importo: 50 }]
    h.saldo.mockResolvedValue(20) // saldo 20 < eccedenza 50
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(409)
    expect(h.storno).not.toHaveBeenCalled()
  })

  it('eccedenza a credito recuperabile → storno credito con saldo_dopo aggiornato', async () => {
    h.eccedenzaRows = [{ importo: 50 }]
    h.saldo.mockResolvedValue(80)
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(200)
    const rev = h.inserts.find((i) => i.table === 'crediti_famiglia')!.row as { causale: string; importo: number; saldo_dopo: number }
    expect(rev.causale).toBe('storno')
    expect(rev.importo).toBe(-50)
    expect(rev.saldo_dopo).toBe(30)
  })

  it('transazione non trovata → 404', async () => {
    h.tx = null
    const res = await POST(post({ motivo: 'errore di registrazione' }), ctx)
    expect(res.status).toBe(404)
  })
})
