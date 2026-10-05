import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LA CODA FATTURE DAVANTI A UNA RIAPERTURA — `src/lib/pagamenti/riapertura-coda-fatture.ts`.
 *
 * Il caso che ha fatto nascere il modulo: un bonifico associato alla retta
 * sbagliata aveva messo in coda la fattura di QUELLA retta; riaperto il bonifico,
 * la voce tornava da pagare ma la richiesta restava in coda («errore», poi «non
 * saldato» a ogni giro).
 *
 * ─── COME MORDONO QUESTI TEST ───────────────────────────────────────────────
 * Il finto Supabase NON risponde sempre la stessa cosa: FILTRA le righe che
 * gli si danno con i filtri che il codice gli applica davvero (`.eq`, `.in`).
 * Così «la RPC parte con il solo id della voce non saldata» è una conseguenza
 * del codice e non del finto: togliendo il filtro `stato !== 'pagato'` la voce
 * saldata porta in RPC anche la sua richiesta, e il test cade.
 *
 * Dati SINTETICI: uuid finti, nessun nome.
 */

const h = vi.hoisted(() => ({
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/logging/logger', () => ({
  logErrore: h.logErrore,
  logEvento: h.logEvento,
  logOk: vi.fn(),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  vociDelMovimento,
  codaInInvio,
  togliCodaVociNonSaldate,
} from '@/lib/pagamenti/riapertura-coda-fatture'

type Errore = { code: string; message: string }
type Riga = Record<string, unknown>

interface Stato {
  righe: Record<string, Riga[]>
  errori: Record<string, Errore | null>
  rpcErrore: Errore | null
  letture: { table: string; cols: string; filtri: Record<string, unknown> }[]
  rpc: { name: string; args: Record<string, unknown> }[]
}

let s: Stato

/** Una riga passa un filtro se: array → il valore è fra quelli; scalare → è uguale. */
const passa = (riga: Riga, filtri: Record<string, unknown>) =>
  Object.entries(filtri).every(([c, v]) => (Array.isArray(v) ? v.includes(riga[c]) : riga[c] === v))

function finto(): SupabaseClient {
  return {
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      let cols = ''
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { cols = c ?? ''; return b }
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.limit = () => b
      b.then = (resolve: (v: unknown) => unknown) => {
        s.letture.push({ table, cols, filtri: { ...filtri } })
        const err = s.errori[table] ?? null
        if (err) return resolve({ data: null, error: err })
        return resolve({ data: (s.righe[table] ?? []).filter((r) => passa(r, filtri)), error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      s.rpc.push({ name, args })
      if (s.rpcErrore) return { data: null, error: s.rpcErrore }
      // Come la RPC vera: conta le richieste che ha tolto.
      return { data: (args.p_ids as unknown[]).length, error: null }
    },
  } as unknown as SupabaseClient
}

const OP = 'test:riapertura'
const ATTORE = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const TX = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const C1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const C3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'

const letteDa = (t: string) => s.letture.filter((l) => l.table === t)
const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  s = { righe: {}, errori: {}, rpcErrore: null, letture: [], rpc: [] }
})

describe('vociDelMovimento — le voci toccate dalla riapertura', () => {
  it('unisce la voce singola e quelle degli incassi della transazione, SENZA doppioni', async () => {
    s.righe.incassi = [
      { transazione_id: TX, pagamento_id: P1 },
      { transazione_id: TX, pagamento_id: P2 },
      { transazione_id: TX, pagamento_id: P2 },
      // Una ricarica mensa o un'eccedenza: nessuna voce da guardare.
      { transazione_id: TX, pagamento_id: null },
    ]

    const voci = await vociDelMovimento(finto(), { pagamento_id: P1, transazione_id: TX }, OP)

    expect([...voci].sort()).toEqual([P1, P2])
    expect(letteDa('incassi')).toHaveLength(1)
    expect(letteDa('incassi')[0].filtri).toEqual({ transazione_id: TX })
  })

  it('senza transazione: la sola voce abbinata, e nessuna lettura', async () => {
    expect(await vociDelMovimento(finto(), { pagamento_id: P1, transazione_id: null }, OP)).toEqual([P1])
    expect(s.letture).toEqual([])
  })

  it('lettura degli incassi fallita: resta la voce singola, e un `warn` lo dice', async () => {
    s.errori.incassi = { code: 'XX000', message: 'guasto' }

    expect(await vociDelMovimento(finto(), { pagamento_id: P1, transazione_id: TX }, OP)).toEqual([P1])
    const riga = eventi('voci-transazione-non-lette')
    expect(riga, 'una lettura fallita senza una riga di log').toHaveLength(1)
    expect(riga[0][1]).toBe('warn')
  })
})

describe('codaInInvio — una richiesta IN INVIO ferma la riapertura', () => {
  it('una richiesta `in_invio` sulla voce → `{ inInvio: true }`', async () => {
    s.righe.fatture_coda = [{ id: C1, pagamento_id: P1, stato: 'in_invio' }]

    expect(await codaInInvio(finto(), [P1], OP)).toEqual({ inInvio: true })
    const l = letteDa('fatture_coda')
    expect(l).toHaveLength(1)
    expect(l[0].filtri).toEqual({ pagamento_id: [P1], stato: 'in_invio' })
  })

  it('una richiesta soltanto `in_coda` o `errore` NON ferma niente', async () => {
    s.righe.fatture_coda = [
      { id: C1, pagamento_id: P1, stato: 'in_coda' },
      { id: C2, pagamento_id: P2, stato: 'errore' },
    ]

    expect(await codaInInvio(finto(), [P1, P2], OP)).toEqual({ inInvio: false })
  })

  it('una richiesta `in_invio` su una voce che NON è del movimento non ferma niente', async () => {
    s.righe.fatture_coda = [{ id: C1, pagamento_id: P2, stato: 'in_invio' }]

    expect(await codaInInvio(finto(), [P1], OP)).toEqual({ inInvio: false })
  })

  it('nessuna voce: nessuna lettura', async () => {
    expect(await codaInInvio(finto(), [], OP)).toEqual({ inInvio: false })
    expect(s.letture).toEqual([])
  })

  it('tabella assente (42P01, DB E2E non migrato) → `{ inInvio: false }`, `info` e non errore', async () => {
    s.errori.fatture_coda = { code: '42P01', message: 'relation "fatture_coda" does not exist' }

    expect(await codaInInvio(finto(), [P1], OP)).toEqual({ inInvio: false })
    expect(h.logErrore).not.toHaveBeenCalled()
    // Ignorabile, ma non muto: un ramo di degradazione che nessuno vede è la
    // prima metà di ogni guasto lungo.
    const riga = eventi('coda-fatture-assente')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('info')
  })

  it('un guasto qualunque (XX000) → `{ guasto: true }`, fail-CLOSED, con un `logErrore`', async () => {
    s.errori.fatture_coda = { code: 'XX000', message: 'internal error' }

    expect(await codaInInvio(finto(), [P1], OP)).toEqual({ guasto: true })
    expect(
      h.logErrore.mock.calls.find(
        (c) => (c[0] as { evento?: string })?.evento === 'coda_fatture_non_letta_riapertura',
      ),
      'un guasto di lettura senza una riga di log',
    ).toBeTruthy()
  })
})

describe('togliCodaVociNonSaldate — dopo lo storno si tolgono le richieste delle voci non più saldate', () => {
  it('voce `pagato` e voce `da_pagare`, entrambe con richiesta `errore` → la RPC toglie SOLO la seconda', async () => {
    s.righe.pagamenti = [
      { id: P1, stato: 'pagato' },
      { id: P2, stato: 'da_pagare' },
    ]
    s.righe.fatture_coda = [
      // La voce ancora saldata da altri incassi TIENE la sua richiesta.
      { id: C1, pagamento_id: P1, stato: 'errore' },
      { id: C2, pagamento_id: P2, stato: 'errore' },
    ]

    const n = await togliCodaVociNonSaldate(finto(), [P1, P2], ATTORE, OP)

    expect(n).toBe(1)
    expect(s.rpc).toEqual([{ name: 'fatture_coda_togli', args: { p_ids: [C2], p_attore: ATTORE } }])
    const ok = eventi('coda-fatture-tolta-dopo-riapertura')
    expect(ok, 'il successo di un evento critico non lasciava traccia').toHaveLength(1)
    expect(ok[0][1]).toBe('info')
    expect((ok[0][2] as { n?: number }).n).toBe(1)
  })

  it('si tolgono `in_coda` ed `errore`, MAI `in_invio`, `emessa` o `tolta`', async () => {
    s.righe.pagamenti = [{ id: P1, stato: 'da_pagare' }]
    s.righe.fatture_coda = [
      { id: C1, pagamento_id: P1, stato: 'in_coda' },
      { id: C2, pagamento_id: P1, stato: 'emessa' },
      { id: C3, pagamento_id: P1, stato: 'tolta' },
    ]

    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(1)
    expect(s.rpc[0].args.p_ids).toEqual([C1])
    expect(letteDa('fatture_coda')[0].filtri.stato).toEqual(['in_coda', 'errore'])
  })

  it('tutte le voci ancora saldate: niente coda letta, niente RPC, 0', async () => {
    s.righe.pagamenti = [{ id: P1, stato: 'pagato' }]
    s.righe.fatture_coda = [{ id: C1, pagamento_id: P1, stato: 'errore' }]

    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    expect(letteDa('fatture_coda')).toEqual([])
    expect(s.rpc).toEqual([])
  })

  it('nessuna voce: nessuna lettura, 0', async () => {
    expect(await togliCodaVociNonSaldate(finto(), [], ATTORE, OP)).toBe(0)
    expect(s.letture).toEqual([])
  })

  it('RPC in errore → 0, e un log `error` col numero delle richieste', async () => {
    s.righe.pagamenti = [{ id: P1, stato: 'da_pagare' }]
    s.righe.fatture_coda = [{ id: C1, pagamento_id: P1, stato: 'errore' }]
    s.rpcErrore = { code: 'XX000', message: 'internal error' }

    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    const riga = eventi('coda-fatture-non-tolta')
    expect(riga, 'una RPC fallita senza una riga di log').toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect((riga[0][2] as { n?: number }).n).toBe(1)
    expect(eventi('coda-fatture-tolta-dopo-riapertura'), 'un successo dichiarato su una RPC fallita').toEqual([])
  })

  it('RPC assente (PGRST202, DB E2E non migrato) → 0, log `info` e non `error`', async () => {
    s.righe.pagamenti = [{ id: P1, stato: 'da_pagare' }]
    s.righe.fatture_coda = [{ id: C1, pagamento_id: P1, stato: 'errore' }]
    s.rpcErrore = { code: 'PGRST202', message: 'Could not find the function' }

    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    expect(eventi('coda-fatture-non-tolta')[0][1]).toBe('info')
  })

  it('lettura delle voci fallita → 0, log `error`, nessuna RPC', async () => {
    s.errori.pagamenti = { code: 'XX000', message: 'internal error' }

    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    const riga = eventi('coda-fatture-voci-non-lette')
    expect(riga).toHaveLength(1)
    expect(riga[0][1]).toBe('error')
    expect(s.rpc).toEqual([])
  })

  it('lettura della coda fallita: `error` su un guasto, `info` sulla tabella assente', async () => {
    s.righe.pagamenti = [{ id: P1, stato: 'da_pagare' }]
    s.errori.fatture_coda = { code: 'XX000', message: 'internal error' }
    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    expect(eventi('coda-fatture-non-letta')).toHaveLength(1)
    expect(eventi('coda-fatture-non-letta')[0][1]).toBe('error')

    vi.clearAllMocks()
    s.errori.fatture_coda = { code: '42P01', message: 'relation does not exist' }
    expect(await togliCodaVociNonSaldate(finto(), [P1], ATTORE, OP)).toBe(0)
    expect(eventi('coda-fatture-non-letta')).toHaveLength(1)
    expect(eventi('coda-fatture-non-letta')[0][1]).toBe('info')
    expect(s.rpc).toEqual([])
  })
})
