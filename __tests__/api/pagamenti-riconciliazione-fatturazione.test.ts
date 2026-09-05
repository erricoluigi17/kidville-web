import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/riconciliazione — lo STATO DI FATTURAZIONE sulle righe confermate.
 *
 * ⚠️ IL FINTO CLIENT QUI SOTTO NON È PIATTO, ed è il punto di questo file.
 * Un mock che risponde le stesse righe a ogni `from(…)` sarebbe verde CON e SENZA la
 * correzione: `fattura_stato` arriverebbe anche da `riconciliazione_movimenti`, che quella
 * colonna non ce l'ha. Qui ogni tabella ha il suo elenco (`h.db`), e la risposta è
 * PROIETTATA sulle sole colonne chieste nella `select(…)` — esattamente come fa PostgREST.
 * Conseguenze volute:
 *   · se la route non aggiunge `fattura_stato` alla `select` batch, il campo esce `null`;
 *   · se la route non estende gli id ai `pagamento_id` dei CONFERMATI, il `.in('id', …)`
 *     non pesca la riga e il campo esce `null`;
 *   · lo `stato` del MOVIMENTO ('confermato') e lo `stato` del PAGAMENTO ('pagato') sono
 *     due valori diversi in due tabelle diverse: scambiarli si vede.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sediAttive: ['sc-1'] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message: string } | null>,
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => h.sediAttive,
}))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => {
  type Filtro = { op: 'eq' | 'in' | 'gte' | 'lte'; col: string; val: unknown }

  const proietta = (riga: Record<string, unknown>, cols: string) => {
    const chiavi = cols.split(',').map((c) => c.trim()).filter(Boolean)
    if (chiavi.length === 0) return { ...riga }
    return Object.fromEntries(chiavi.map((k) => [k, k in riga ? riga[k] : null]))
  }

  const passa = (riga: Record<string, unknown>, filtri: Filtro[]) =>
    filtri.every((f) => {
      const v = riga[f.col]
      if (f.op === 'eq') return v === f.val
      if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v)
      if (f.op === 'gte') return String(v) >= String(f.val)
      return String(v) <= String(f.val)
    })

  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        const filtri: Filtro[] = []
        let cols = ''
        const b: Record<string, unknown> = {}
        b.select = (c?: string) => { cols = c ?? ''; return b }
        b.eq = (col: string, val: unknown) => { filtri.push({ op: 'eq', col, val }); return b }
        b.in = (col: string, val: unknown) => { filtri.push({ op: 'in', col, val }); return b }
        b.gte = (col: string, val: unknown) => { filtri.push({ op: 'gte', col, val }); return b }
        b.lte = (col: string, val: unknown) => { filtri.push({ op: 'lte', col, val }); return b }
        b.order = () => b
        b.limit = () => b
        b.range = () => b
        b.then = (resolve: (v: unknown) => unknown) => {
          const errore = h.errori[table] ?? null
          if (errore) return resolve({ data: null, error: errore })
          const righe = (h.db[table] ?? []).filter((r) => passa(r, filtri))
          return resolve({ data: righe.map((r) => proietta(r, cols)), error: null })
        }
        return b
      },
    }),
  }
})

import { GET } from '@/app/api/pagamenti/riconciliazione/route'

const MID = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`
const PID = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione${qs}`) as never)

/** Movimento del registro: lo `stato` qui è quello del MOVIMENTO, mai quello del pagamento. */
const mov = (n: number, stato: string, pagamentoId: string | null, extra: Record<string, unknown> = {}) => ({
  id: MID(n),
  import_id: null,
  scuola_id: stato === 'confermato' ? 'sc-1' : null,
  data_operazione: '2026-09-05',
  importo: 150,
  causale: 'BONIFICO RETTA',
  controparte: 'ORDINANTE',
  stato,
  suggerimenti: null,
  pagamento_id: pagamentoId,
  confermato_il: stato === 'confermato' ? '2026-09-05T10:00:00Z' : null,
  ...extra,
})

/** Riga di `pagamenti`: qui vivono `stato` (del pagamento) e `fattura_stato`. */
const pag = (n: number, statoPagamento: string, fatturaStato: string | null, scuolaId: string | null = 'sc-1') => ({
  id: PID(n),
  scuola_id: scuolaId,
  stato: statoPagamento,
  fattura_stato: fatturaStato,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {}
  h.errori = {}
  h.eventi = []
  h.sediAttive = ['sc-1']
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('GET /api/pagamenti/riconciliazione — stato di fatturazione della riga', () => {
  it('riga CONFERMATA di sede attiva: `pagamento_stato` e `fattura_stato` arrivano da `pagamenti`', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'confermato', PID(1))]
    h.db.pagamenti = [pag(1, 'pagato', 'non_richiesta')]

    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    // lo stato del MOVIMENTO resta quello del registro (non viene sovrascritto dal pagamento)
    expect(j.data[0].stato).toBe('confermato')
    expect(j.data[0].pagamento_stato).toBe('pagato')
    expect(j.data[0].fattura_stato).toBe('non_richiesta')
  })

  it('riga confermata di sede NON attiva: entrambi i campi `null` (minimizzazione)', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'confermato', PID(1))]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa', 'sc-99')]

    const j = await (await get()).json()
    expect(j.data[0].pagamento_stato).toBeNull()
    expect(j.data[0].fattura_stato).toBeNull()
  })

  it('righe suggerito / da_abbinare / ignorato: entrambi i campi `null` anche col pagamento in mano', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'suggerito', PID(1)),
      mov(2, 'da_abbinare', PID(2)),
      mov(3, 'ignorato', PID(3)),
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa'), pag(2, 'pagato', 'emessa'), pag(3, 'pagato', 'emessa')]

    const j = await (await get()).json()
    expect(j.data).toHaveLength(3)
    for (const r of j.data) {
      expect(r.pagamento_stato).toBeNull()
      expect(r.fattura_stato).toBeNull()
    }
  })

  it('i due campi ci sono SEMPRE, anche quando non c’è nessun pagamento da risolvere', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'da_abbinare', null)]
    h.db.pagamenti = []

    const j = await (await get()).json()
    expect(j.data[0]).toHaveProperty('pagamento_stato', null)
    expect(j.data[0]).toHaveProperty('fattura_stato', null)
  })

  it('?fattura=da_fatturare: solo confermate+pagate con fattura non_richiesta o scartata', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)), // pagato · non_richiesta   → SÌ
      mov(2, 'confermato', PID(2)), // pagato · scartata        → SÌ
      mov(3, 'confermato', PID(3)), // parziale · non_richiesta → no (non pagato)
      mov(4, 'confermato', PID(4)), // pagato · in_attesa       → no
      mov(5, 'confermato', PID(5)), // pagato · emessa          → no
      mov(6, 'suggerito', null),    // nemmeno confermata       → no
    ]
    h.db.pagamenti = [
      pag(1, 'pagato', 'non_richiesta'),
      pag(2, 'pagato', 'scartata'),
      pag(3, 'parziale', 'non_richiesta'),
      pag(4, 'pagato', 'in_attesa'),
      pag(5, 'pagato', 'emessa'),
    ]

    const j = await (await get('?fattura=da_fatturare')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(1), MID(2)])
  })

  it('?fattura=fatturate: solo in_attesa ed emessa', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)),
      mov(2, 'confermato', PID(2)),
      mov(3, 'confermato', PID(3)),
      mov(4, 'confermato', PID(4)),
      mov(5, 'confermato', PID(5)),
    ]
    h.db.pagamenti = [
      pag(1, 'pagato', 'non_richiesta'),
      pag(2, 'pagato', 'scartata'),
      pag(3, 'parziale', 'non_richiesta'),
      pag(4, 'pagato', 'in_attesa'),
      pag(5, 'pagato', 'emessa'),
    ]

    const j = await (await get('?fattura=fatturate')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(4), MID(5)])
  })

  it('?stato=confermato&fattura=da_fatturare: i due filtri si compongono', async () => {
    // Le tre righe cadono per tre ragioni diverse, e servono TUTTE: senza la 5 il caso
    // sarebbe verde anche con il filtro `fattura` inesistente (lo `?stato=` da solo basterebbe).
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)), // pagato · non_richiesta → SÌ
      mov(5, 'confermato', PID(5)), // pagato · emessa        → cade sul filtro FATTURA
      mov(6, 'suggerito', null),    // cade sul filtro STATO
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'non_richiesta'), pag(5, 'pagato', 'emessa')]

    const j = await (await get('?stato=confermato&fattura=da_fatturare')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(1)])
  })

  it('?fattura=valore-sconosciuto → 400 (come gli altri parametri)', async () => {
    expect((await get('?fattura=x')).status).toBe(400)
    expect((await get('?fattura=emessa')).status).toBe(400)
  })

  it('batch su `pagamenti` fallito → 200, campi `null`, label dei suggerimenti oscurati, evento loggato', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1), {
        suggerimenti: [{ pagamento_id: PID(1), score: 90, label: 'Nome Cognome · Retta' }],
      }),
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa')]
    h.errori.pagamenti = { code: '08006', message: 'connection failure' }

    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].pagamento_stato).toBeNull()
    expect(j.data[0].fattura_stato).toBeNull()
    expect(j.data[0].suggerimenti[0].label).toBeNull()
    const esiti = h.eventi.filter((e) => e.evento === 'pagamento').map((e) => e.campi.esito)
    expect(esiti).toContain('fatturazione_movimenti_non_risolta')
  })
})
