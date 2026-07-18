import { describe, it, expect } from 'vitest'
import { accreditaEccedenza, saldoCredito, creditoDisponibile } from '@/lib/pagamenti/credito'

// Helper condiviso del credito famiglia (slice S3). La tabella crediti_famiglia è
// un ledger ancorato a parents.id: ogni riga porta il saldo_dopo cumulato.
// Regole chiave: importo ≠ 0 (CHECK DB), saldo_dopo ≥ 0 (CHECK DB), degradazione
// pulita se la tabella/colonna non esiste (DB E2E CI non migrato).

interface DbOpts {
  read?: { data: unknown; error: unknown }
  insert?: { data: unknown; error: unknown }
  probe?: { data: unknown; error: unknown }
  inserted: { table: string; row: unknown }[]
}

function db(opts: DbOpts) {
  return {
    from(table: string) {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => opts.read ?? { data: null, error: null }
      b.insert = (row: unknown) => { opts.inserted.push({ table, row }); b._op = 'insert'; return b }
      b.single = async () => opts.insert ?? { data: { id: 'cf-x', saldo_dopo: 0 }, error: null }
      // creditoDisponibile awaita direttamente `.select().limit()`: b è thenable.
      b.then = (resolve: (v: unknown) => unknown) => resolve(opts.probe ?? { data: [], error: null })
      return b
    },
  }
}

const P1 = '11111111-1111-4111-8111-111111111111'
const S1 = '22222222-2222-4222-8222-222222222222'

describe('saldoCredito', () => {
  it('somma cumulata = saldo_dopo dell\'ultima riga', async () => {
    const s = await saldoCredito(db({ inserted: [], read: { data: { saldo_dopo: 42.5 }, error: null } }) as never, P1)
    expect(s).toBe(42.5)
  })
  it('nessuna riga → 0', async () => {
    const s = await saldoCredito(db({ inserted: [], read: { data: null, error: null } }) as never, P1)
    expect(s).toBe(0)
  })
  it('schema assente (42P01) → 0 (degrada, non lancia)', async () => {
    const s = await saldoCredito(db({ inserted: [], read: { data: null, error: { code: '42P01' } } }) as never, P1)
    expect(s).toBe(0)
  })
})

describe('accreditaEccedenza', () => {
  it('inserisce riga causale eccedenza con saldo_dopo cumulato', async () => {
    const opts: DbOpts = {
      inserted: [],
      read: { data: { saldo_dopo: 20 }, error: null },
      insert: { data: { id: 'cf-1', saldo_dopo: 70 }, error: null },
    }
    const r = await accreditaEccedenza(db(opts) as never, { parentId: P1, scuolaId: S1, importo: 50, incassoId: 'inc-1', creatoDa: 'seg-1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.saldoDopo).toBe(70)
    const row = opts.inserted[0].row as Record<string, unknown>
    expect(row).toMatchObject({ parent_id: P1, scuola_id: S1, causale: 'eccedenza', importo: 50, saldo_dopo: 70, incasso_id: 'inc-1', creato_da: 'seg-1' })
  })
  it('tabella assente (PGRST205) → { ok:false, non_disponibile } e NESSUNA scrittura', async () => {
    const opts: DbOpts = { inserted: [], read: { data: null, error: { code: 'PGRST205' } } }
    const r = await accreditaEccedenza(db(opts) as never, { parentId: P1, scuolaId: S1, importo: 50 })
    expect(r).toEqual({ ok: false, motivo: 'non_disponibile' })
    expect(opts.inserted).toHaveLength(0)
  })
  it('importo non positivo → errore, nessuna scrittura', async () => {
    const opts: DbOpts = { inserted: [], read: { data: { saldo_dopo: 0 }, error: null } }
    const r = await accreditaEccedenza(db(opts) as never, { parentId: P1, scuolaId: S1, importo: 0 })
    expect(r.ok).toBe(false)
    expect(opts.inserted).toHaveLength(0)
  })
})

describe('creditoDisponibile', () => {
  it('vero quando la probe non torna un codice di schema-mancante', async () => {
    const ok = await creditoDisponibile(db({ inserted: [], probe: { data: [], error: null } }) as never)
    expect(ok).toBe(true)
  })
  it('falso quando la tabella non esiste (42P01)', async () => {
    const ok = await creditoDisponibile(db({ inserted: [], probe: { data: null, error: { code: '42P01' } } }) as never)
    expect(ok).toBe(false)
  })
})
