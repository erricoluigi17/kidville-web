import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─── I FILTRI DELLA CONCILIAZIONE, MISURATI SULLA QUERY CHE PRODUCONO ───────
 *
 * Questo banco non guarda le righe che tornano: guarda la richiesta che parte.
 * È una garanzia più forte di `.strict()` sullo schema — che qui non si può
 * aggiungere, perché la pagina manda `?userId=` su ogni GET e lo schema non lo
 * dichiara: `.strict()` farebbe 400 su OGNI richiesta.
 *
 * Uno schema che accetta una chiave e una query che non la usa hanno lo stesso
 * colore: verde. Solo misurando `.gte`/`.lte`/`.or` si distingue «il filtro
 * c'è» da «il filtro è dichiarato».
 */
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  /** Ogni interrogazione così com'è partita: tabella e catena di filtri. */
  chiamate: [] as { tabella: string; filtri: { op: string; a: unknown; b?: unknown }[]; limite: number | null }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const filtri: { op: string; a: unknown; b?: unknown }[] = []
      let limite: number | null = null
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (a: unknown, v: unknown) => { filtri.push({ op: 'eq', a, b: v }); return b }
      b.in = (a: unknown, v: unknown) => { filtri.push({ op: 'in', a, b: v }); return b }
      b.gte = (a: unknown, v: unknown) => { filtri.push({ op: 'gte', a, b: v }); return b }
      b.lte = (a: unknown, v: unknown) => { filtri.push({ op: 'lte', a, b: v }); return b }
      b.or = (a: unknown) => { filtri.push({ op: 'or', a }); return b }
      b.order = () => b
      b.limit = (n: number) => { limite = n; return b }
      b.range = () => b
      b.then = (resolve: (v: unknown) => unknown) => {
        h.chiamate.push({ tabella: table, filtri: [...filtri], limite })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/riconciliazione/route'

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione?userId=u1${qs}`, { headers: { 'x-user-id': 'u1' } }) as never)

/** I filtri della sola interrogazione al registro. */
const delRegistro = () => h.chiamate.find((c) => c.tabella === 'riconciliazione_movimenti')?.filtri ?? []

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.requireStaff.mockResolvedValue({ user: { id: 'u1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('la ricerca testuale finisce nella query, non in memoria', () => {
  it('`?q=` produce un `.or(ilike)` su causale e ordinante', async () => {
    await get('&q=rossi')
    const or = delRegistro().find((f) => f.op === 'or')
    expect(or).toBeTruthy()
    expect(String(or!.a)).toMatch(/causale\.ilike/)
    expect(String(or!.a)).toMatch(/controparte\.ilike/)
    expect(String(or!.a)).toMatch(/rossi/i)
  })

  it('un termine fatto di soli metacaratteri NON produce nessun `.or`', async () => {
    // `.or('')` è un filtro che passa tutto scritto come se restringesse: senza la
    // guardia, questa ricerca darebbe l'elenco intero spacciato per un risultato
    await get('&q=' + encodeURIComponent(',,%()'))
    expect(delRegistro().some((f) => f.op === 'or')).toBe(false)
  })

  it('un termine vuoto non filtra niente', async () => {
    await get('&q=')
    expect(delRegistro().some((f) => f.op === 'or')).toBe(false)
  })

  it('la virgola dentro il termine non spezza la condizione', async () => {
    await get('&q=' + encodeURIComponent('rossi, maria'))
    const or = delRegistro().find((f) => f.op === 'or')!
    // due colonne = due condizioni: le virgole del termine sono state tolte
    expect(String(or.a).split('causale.ilike').length - 1).toBe(1)
  })

  it('oltre 200 caratteri è un 400, non una query gigante', async () => {
    const res = await get('&q=' + 'a'.repeat(201))
    expect(res.status).toBe(400)
  })
})

describe("l'intervallo d'importo è SQL, non un filtro in memoria", () => {
  it('`importoDa` e `importoA` diventano `.gte` e `.lte` su `importo`', async () => {
    await get('&importoDa=50&importoA=200')
    const f = delRegistro()
    expect(f).toContainEqual({ op: 'gte', a: 'importo', b: 50 })
    expect(f).toContainEqual({ op: 'lte', a: 'importo', b: 200 })
  })

  it('un solo estremo basta', async () => {
    await get('&importoDa=50')
    const f = delRegistro()
    expect(f.some((x) => x.op === 'gte' && x.a === 'importo')).toBe(true)
    expect(f.some((x) => x.op === 'lte' && x.a === 'importo')).toBe(false)
  })

  it('minimo maggiore del massimo NON si auto-corregge: la query esce così com’è chiesta', async () => {
    await get('&importoDa=200&importoA=50')
    const f = delRegistro()
    expect(f).toContainEqual({ op: 'gte', a: 'importo', b: 200 })
    expect(f).toContainEqual({ op: 'lte', a: 'importo', b: 50 })
  })

  it('importo zero è un valore, non un «non filtrare»', async () => {
    await get('&importoDa=0')
    expect(delRegistro()).toContainEqual({ op: 'gte', a: 'importo', b: 0 })
  })

  it('un importo non numerico è un 400', async () => {
    expect((await get('&importoDa=abc')).status).toBe(400)
    expect((await get('&importoDa=-5')).status).toBe(400)
  })
})

describe('il periodo resta quello di sempre, e continua a validare sul calendario', () => {
  it('`da` e `a` filtrano `data_operazione`', async () => {
    await get('&da=2026-09-01&a=2026-09-30')
    const f = delRegistro()
    expect(f).toContainEqual({ op: 'gte', a: 'data_operazione', b: '2026-09-01' })
    expect(f).toContainEqual({ op: 'lte', a: 'data_operazione', b: '2026-09-30' })
  })

  it('una data che sul calendario non esiste è un 400', async () => {
    // Il rinominamento in `dataDa`/`dataA` avrebbe fatto sparire proprio questo:
    // senza `.strict()`, una chiave ignota viene scartata in silenzio e la lista
    // esce non filtrata.
    expect((await get('&da=2026-02-30')).status).toBe(400)
    expect((await get('&da=05-09-2026')).status).toBe(400)
  })
})

describe('i filtri si compongono, e la finestra li vede', () => {
  it('ricerca + periodo + importo viaggiano nella STESSA interrogazione', async () => {
    await get('&q=rossi&da=2026-09-01&importoDa=10&stato=confermato')
    const f = delRegistro()
    expect(f.some((x) => x.op === 'or')).toBe(true)
    expect(f).toContainEqual({ op: 'gte', a: 'data_operazione', b: '2026-09-01' })
    expect(f).toContainEqual({ op: 'gte', a: 'importo', b: 10 })
    expect(f).toContainEqual({ op: 'eq', a: 'stato', b: 'confermato' })
    // una sola interrogazione al registro: i filtri restringono la SQL, non una
    // pagina già portata a casa
    expect(h.chiamate.filter((c) => c.tabella === 'riconciliazione_movimenti')).toHaveLength(1)
  })

  it('la finestra chiede sempre una riga in più del tetto', async () => {
    await get('&q=rossi')
    expect(h.chiamate.find((c) => c.tabella === 'riconciliazione_movimenti')?.limite).toBe(501)
  })
})
