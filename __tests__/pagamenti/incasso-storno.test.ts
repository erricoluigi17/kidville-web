import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/incassi/storno — storno tracciato (slice S3):
//  (c) senza motivo → 400; storno = contro-incasso negativo metodo='storno'
//  collegato all'originale; 409 se già stornato o se è esso stesso uno storno.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  orig: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
  // Simula lo schema NON migrato dove l'enum `incasso_metodo` non ha 'storno':
  // il primo INSERT (metodo='storno') fallisce con 22P02 → scatta il fallback.
  forza22P02: false,
  // Errori pilotabili delle tre scritture SECONDARIE, che vengono DOPO il
  // contro-incasso: marcatura dell'originale, RPC di ricalcolo, audit. Lo storno
  // a quel punto è avvenuto, quindi la risposta resta 200 — ma l'errore non può
  // più essere muto (prima erano tre `.then(() => {}, () => {})`).
  erroreMarca: null as { code: string; message: string } | null,
  erroreRicalcolo: null as { code: string; message: string } | null,
  erroreAudit: null as { code: string; message: string } | null,
  // La RPC RIGETTA invece di rispondere `{ error }` (rete, client): raro, ma il
  // vecchio `.then(() => {}, () => {})` lo ingoiava, e la risposta deve restare 200.
  rpcRigetta: false,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

// Logger vero per tutto il resto (withRoute), spie su logEvento/logErrore.
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

// Scope di sede concessivo: qui si verificano i movimenti contabili e i legami,
// non l'isolamento fra sedi (che sta in
// `__tests__/api/contabilita-scope-sede.test.ts`).
vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
  assertAlunnoInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
  assertUtenteInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['sc-1']),
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: 'sc-1' })),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => {
      if (h.rpcRigetta) throw new Error('fetch failed')
      return { data: null, error: h.erroreRicalcolo }
    },
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'incassi' ? { data: h.orig, error: null } : { data: null, error: null })
      b.single = async () => {
        // Solo l'INSERT con metodo='storno' su incassi fallisce quando l'enum non ha il valore.
        if (table === 'incassi' && h.forza22P02 && (b._row as { metodo?: string } | undefined)?.metodo === 'storno') {
          return { data: null, error: { code: '22P02', message: 'invalid input value for enum incasso_metodo: "storno"' } }
        }
        return { data: { id: `${table}-new` }, error: null }
      }
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; b._row = row; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.then = (resolve: (v: unknown) => unknown) => {
        // Le sole scritture che arrivano qui con un `await` sul builder: l'UPDATE
        // della marcatura su `incassi` e l'INSERT dell'audit su `registro_modifiche`.
        if (table === 'incassi' && b._op === 'update') return resolve({ data: null, error: h.erroreMarca })
        if (table === 'registro_modifiche' && b._op === 'insert') return resolve({ data: null, error: h.erroreAudit })
        return resolve({ data: null, error: null })
      }
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
  h.orig = { id: INC, pagamento_id: 'p-1', importo: 100, metodo: 'contanti', storno_di: null, stornato_il: null }
  h.inserts = []; h.updates = []
  h.forza22P02 = false
  h.erroreMarca = null
  h.erroreRicalcolo = null
  h.erroreAudit = null
  h.rpcRigetta = false
})

/** Le chiamate a logEvento con un dato `esito`: [evento, livello, campi, err]. */
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

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

  // P9 — ramo degradato (enum senza 'storno', 22P02): il fallback scrive metodo='altro'
  // ma DEVE mantenere `storno_di`, altrimenti `sommaEntrateAutoContanti` non riconosce
  // lo storno e il saldo cassa resta gonfiato (dimostrato dal caso negativo in saldo.test.ts).
  it('fallback 22P02 → contro-incasso metodo=altro CON storno_di collegato', async () => {
    h.forza22P02 = true
    const res = await POST(post({ incasso_id: INC, motivo: 'errore di cassa' }))
    expect(res.status).toBe(200)
    const incInserts = h.inserts.filter((i) => i.table === 'incassi').map((i) => i.row as Record<string, unknown>)
    expect(incInserts).toHaveLength(2)
    // Primo insert: tentativo con metodo='storno' (fallito 22P02).
    expect(incInserts[0].metodo).toBe('storno')
    // Secondo insert: fallback degradato.
    const fallback = incInserts[1]
    expect(fallback.metodo).toBe('altro')
    expect(fallback.note).toBe('Storno')
    expect(fallback.storno_di).toBe(INC)
  })
})

// Task 7 — le tre scritture secondarie dello storno non ingoiano più gli errori.
// Il contro-incasso è già scritto: la risposta resta 200 (il chiamante non cambia),
// ma ogni errore lascia una riga di log con soli uuid e codici, mai il motivo.
describe('POST storno incasso — gli errori secondari si loggano', () => {
  const MOTIVO = 'errore di cassa'

  it('percorso pulito → nessuna delle righe d\'errore secondarie', async () => {
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    for (const esito of ['storno-marcatura-non-scritta', 'ricalcolo-rpc-assente', 'ricalcolo-non-riuscito', 'audit-storno-non-scritto']) {
      expect(eventi(esito), esito).toEqual([])
    }
    expect(eventi('stornato')).toHaveLength(1)
  })

  it('marcatura `stornato_il` in errore (XX000) → 200, logEvento error «storno-marcatura-non-scritta»', async () => {
    h.erroreMarca = { code: 'XX000', message: 'internal error' }
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('storno-marcatura-non-scritta')
    expect(righe).toHaveLength(1)
    const [evento, livello, campi, err] = righe[0]
    expect(evento).toBe('pagamento')
    expect(livello).toBe('error')
    expect(campi).toMatchObject({ operazione: 'pagamenti/incassi/storno:POST', incasso_id: INC })
    expect(err).toMatchObject({ code: 'XX000' })
    expect(JSON.stringify(campi)).not.toContain(MOTIVO)
  })

  it('marcatura su DB non migrato (42703) → 200, la stessa riga ma a livello info', async () => {
    h.erroreMarca = { code: '42703', message: 'column "stornato_il" does not exist' }
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('storno-marcatura-non-scritta')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('info')
  })

  it('RPC `ricalcola_stato_pagamento` assente (42883) → 200, logEvento info «ricalcolo-rpc-assente»', async () => {
    h.erroreRicalcolo = { code: '42883', message: 'function does not exist' }
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('ricalcolo-rpc-assente')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('info')
    expect(righe[0][2]).toMatchObject({ operazione: 'pagamenti/incassi/storno:POST', pagamento_id: 'p-1' })
    expect(eventi('ricalcolo-non-riuscito')).toEqual([])
  })

  it('RPC `ricalcola_stato_pagamento` in errore vero (XX000) → 200, logEvento error «ricalcolo-non-riuscito»', async () => {
    h.erroreRicalcolo = { code: 'XX000', message: 'internal error' }
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('ricalcolo-non-riuscito')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect(righe[0][3]).toMatchObject({ code: 'XX000' })
    expect(eventi('ricalcolo-rpc-assente')).toEqual([])
  })

  it('RPC che RIGETTA → 200 (lo storno è avvenuto), logEvento error «ricalcolo-non-riuscito», e l\'audit si scrive lo stesso', async () => {
    h.rpcRigetta = true
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('ricalcolo-non-riuscito')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect(h.inserts.some((i) => i.table === 'registro_modifiche')).toBe(true)
  })

  it('audit su `registro_modifiche` in errore → 200, logEvento error «audit-storno-non-scritto», senza il motivo', async () => {
    h.erroreAudit = { code: 'XX000', message: 'internal error' }
    const res = await POST(post({ incasso_id: INC, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const righe = eventi('audit-storno-non-scritto')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect(righe[0][2]).toMatchObject({ operazione: 'pagamenti/incassi/storno:POST', incasso_id: INC })
    expect(JSON.stringify(righe[0][2])).not.toContain(MOTIVO)
  })
})
