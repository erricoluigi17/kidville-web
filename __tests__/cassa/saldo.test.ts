import { describe, it, expect, vi } from 'vitest'
import {
  sommaEntrateAutoContanti,
  calcolaAggregatiMovimenti,
  caricaSaldoCassa,
  CASSA_SCHEMA_ASSENTE,
} from '@/lib/cassa/saldo'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// E1.3 — logica PURA del saldo cassa (test PRIMA dell'implementazione).
// Trappola centrale: lo storno di un incasso CONTANTI (metodo='storno'/'altro'
// + storno_di) deve annullare l'entrata; lo storno di un incasso NON contanti
// non deve toccare il saldo. Convenzione importi: entrata/uscita/prelievo
// positivi, rettifica con segno, storno = contro-movimento a importo negato.
// =============================================================================

describe('sommaEntrateAutoContanti (pura)', () => {
  it('un incasso contanti da 50 → 50', () => {
    expect(sommaEntrateAutoContanti([{ id: 'a', importo: 50, metodo: 'contanti', storno_di: null }])).toBe(50)
  })

  it('incasso contanti 50 + suo storno (metodo storno, -50) → 0', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 50, metodo: 'contanti', storno_di: null },
        { id: 'b', importo: -50, metodo: 'storno', storno_di: 'a' },
      ]),
    ).toBe(0)
  })

  // P9 — nel ramo degradato (enum senza 'storno', 22P02) il fallback scrive
  // metodo='altro' MA con `storno_di` valorizzato (fix E1.5): riconosciuto come
  // storno, sottrae l'originale → 0.
  it('storno DEGRADATO (metodo altro + storno_di) di un incasso contanti → 0', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 50, metodo: 'contanti', storno_di: null },
        { id: 'b', importo: -50, metodo: 'altro', storno_di: 'a' },
      ]),
    ).toBe(0)
  })

  // CASO NEGATIVO (contratto che P9 protegge): senza `storno_di`, il contro-incasso
  // 'altro' NON è riconosciuto come storno e non è contante → l'originale +50 resta
  // contato → saldo GONFIATO (50, non 0). È esattamente il bug che il fallback
  // 22P02 produceva prima di E1.5: dimostra perché il fallback DEVE impostare storno_di.
  it('contro-incasso «altro» SENZA storno_di NON annulla l\'originale → 50 (gonfiato)', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 50, metodo: 'contanti', storno_di: null },
        { id: 'b', importo: -50, metodo: 'altro', storno_di: null },
      ]),
    ).toBe(50)
  })

  it('incassi bonifico/pos/credito_famiglia/rettifica sono ignorati → 0', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 30, metodo: 'bonifico', storno_di: null },
        { id: 'b', importo: 20, metodo: 'pos', storno_di: null },
        { id: 'c', importo: 10, metodo: 'credito_famiglia', storno_di: null },
        { id: 'd', importo: 5, metodo: 'rettifica', storno_di: null },
      ]),
    ).toBe(0)
  })

  it('lo storno di un incasso BONIFICO non viene sottratto → 0', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 30, metodo: 'bonifico', storno_di: null },
        { id: 'b', importo: -30, metodo: 'storno', storno_di: 'a' },
      ]),
    ).toBe(0)
  })

  it('mix: contanti 100 + contanti 40 + storno del solo primo → 40', () => {
    expect(
      sommaEntrateAutoContanti([
        { id: 'a', importo: 100, metodo: 'contanti', storno_di: null },
        { id: 'b', importo: 40, metodo: 'contanti', storno_di: null },
        { id: 'c', importo: -100, metodo: 'storno', storno_di: 'a' },
      ]),
    ).toBe(40)
  })
})

describe('calcolaAggregatiMovimenti (pura)', () => {
  it('uscita contanti 20 → usciteContanti 20', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'uscita', importo: 20, metodo: 'contanti' }])
    expect(r.usciteContanti).toBe(20)
  })

  it('uscita bonifico 80 → NON muove usciteContanti', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'uscita', importo: 80, metodo: 'bonifico' }])
    expect(r.usciteContanti).toBe(0)
  })

  it('uscita 20 + suo storno (-20) → 0', () => {
    const r = calcolaAggregatiMovimenti([
      { tipo: 'uscita', importo: 20, metodo: 'contanti' },
      { tipo: 'uscita', importo: -20, metodo: 'contanti' },
    ])
    expect(r.usciteContanti).toBe(0)
  })

  it('prelievo 28 → prelievi 28', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'prelievo', importo: 28, metodo: 'contanti' }])
    expect(r.prelievi).toBe(28)
  })

  it('rettifica -2 → rettifiche -2 (con segno)', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'rettifica', importo: -2, metodo: 'contanti' }])
    expect(r.rettifiche).toBe(-2)
  })

  it('entrata manuale contanti 10 → entrateManualiContanti 10', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'entrata', importo: 10, metodo: 'contanti' }])
    expect(r.entrateManualiContanti).toBe(10)
  })

  it('entrata manuale con carta (POS) → NON muove entrateManualiContanti', () => {
    const r = calcolaAggregatiMovimenti([{ tipo: 'entrata', importo: 10, metodo: 'carta' }])
    expect(r.entrateManualiContanti).toBe(0)
  })
})

// ── Mock Supabase minimale per l'orchestrazione ──────────────────────────────
interface Op {
  movimenti?: { tipo: string; importo: number; metodo: string }[]
  erroreMov?: { code?: string } | null
  incassiDiretti?: unknown[]
  incassiNulli?: unknown[]
  incassiOggi?: unknown[]
  alunni?: { id: string; scuola_id: string | null }[]
}
function makeSupabase(op: Op): SupabaseClient {
  return {
    from(table: string) {
      const st = { table, eqCols: [] as string[], isCols: [] as string[] }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string) => { st.eqCols.push(col); return b }
      b.is = (col: string) => { st.isCols.push(col); return b }
      b.in = () => b
      b.order = () => b
      b.then = (resolve: (v: unknown) => unknown) => resolve(resolveData(st, op))
      return b
    },
  } as unknown as SupabaseClient
}
function resolveData(st: { table: string; eqCols: string[]; isCols: string[] }, op: Op) {
  if (st.table === 'cassa_movimenti') {
    return op.erroreMov ? { data: null, error: op.erroreMov } : { data: op.movimenti ?? [], error: null }
  }
  if (st.table === 'incassi') {
    if (st.eqCols.includes('data_incasso')) return { data: op.incassiOggi ?? [], error: null }
    if (st.isCols.includes('pagamenti.scuola_id')) return { data: op.incassiNulli ?? [], error: null }
    return { data: op.incassiDiretti ?? [], error: null }
  }
  if (st.table === 'alunni') return { data: op.alunni ?? [], error: null }
  return { data: [], error: null }
}

const SEDE = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

describe('caricaSaldoCassa (orchestrazione — scenari di collaudo 1-4)', () => {
  it('fondo 100 + incasso contanti 50 − uscita 20 = saldo atteso 130', async () => {
    const supabase = makeSupabase({
      movimenti: [{ tipo: 'uscita', importo: 20, metodo: 'contanti' }],
      incassiDiretti: [{ id: 'i1', importo: 50, metodo: 'contanti', storno_di: null }],
    })
    const saldo = await caricaSaldoCassa(supabase, SEDE, 100)
    expect(saldo.disponibile).toBe(true)
    if (saldo.disponibile) {
      expect(saldo.fondo).toBe(100)
      expect(saldo.saldo_atteso).toBe(130)
      expect(saldo.entrate_contanti).toBe(50)
      expect(saldo.uscite_contanti).toBe(20)
      expect(Array.isArray(saldo.entrato_oggi)).toBe(true)
    }
  })

  it('dopo la chiusura (contato 128 su atteso 130): rettifica −2 + prelievo 28 → riparte da 100', async () => {
    const supabase = makeSupabase({
      movimenti: [
        { tipo: 'uscita', importo: 20, metodo: 'contanti' },
        { tipo: 'rettifica', importo: -2, metodo: 'contanti' },
        { tipo: 'prelievo', importo: 28, metodo: 'contanti' },
      ],
      incassiDiretti: [{ id: 'i1', importo: 50, metodo: 'contanti', storno_di: null }],
    })
    const saldo = await caricaSaldoCassa(supabase, SEDE, 100)
    expect(saldo.disponibile).toBe(true)
    if (saldo.disponibile) {
      expect(saldo.saldo_atteso).toBe(100)
      expect(saldo.prelievi).toBe(28)
      expect(saldo.rettifiche).toBe(-2)
    }
  })

  it('degrada a { disponibile:false } quando lo schema cassa è assente (42P01)', async () => {
    const supabase = makeSupabase({ erroreMov: { code: '42P01' } })
    const saldo = await caricaSaldoCassa(supabase, SEDE, 100)
    expect(saldo.disponibile).toBe(false)
  })

  it('CASSA_SCHEMA_ASSENTE copre i codici PostgREST di schema mancante', () => {
    for (const c of ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']) {
      expect(CASSA_SCHEMA_ASSENTE.has(c)).toBe(true)
    }
  })
})

// Silenzia eventuali emissioni del logger fuori dal contesto di richiesta.
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return { ...m }
})
