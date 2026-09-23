// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `leggiCodaAttiva` (consegna 2a, rilievo e): la voce ATTIVA della coda fatture per ogni
 * pagamento, per il chip sulle righe di Pagamenti e Riconciliazione.
 *
 * Due promesse sotto prova: nella mappa entrano SOLO i tre stati attivi, e la funzione non
 * lancia MAI (il chip è un'informazione: la sua assenza non può costare la lista). Una mappa
 * vuota dice due cose diverse — «nessuna voce attiva» e «coda non letta» — e a distinguerle
 * sono i log, che qui si misurano per chiamata.
 *
 * Gli uuid sono finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
// Il logger vero con la sola `logEvento` sostituita.
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { leggiCodaAttiva, MAX_RIGHE_CODA } from '@/lib/fatture-coda/stato-righe'

const OP = 'test:GET'
const risponde = (esito: { data: unknown[] | null; error: unknown }) => () => Promise.resolve(esito)
const esiti = () => h.logEvento.mock.calls.map(([, livello, c]) => [livello, (c as { esito?: string }).esito])

beforeEach(() => {
  h.logEvento.mockReset()
})

describe('leggiCodaAttiva — solo le voci attive', () => {
  it('in_coda, in_invio ed errore entrano; emessa, tolta, uno stato ignoto e un id non stringa no', async () => {
    const mappa = await leggiCodaAttiva(
      risponde({
        data: [
          { pagamento_id: 'pg-1', stato: 'in_coda' },
          { pagamento_id: 'pg-2', stato: 'in_invio' },
          { pagamento_id: 'pg-3', stato: 'errore' },
          { pagamento_id: 'pg-4', stato: 'emessa' },
          { pagamento_id: 'pg-5', stato: 'tolta' },
          { pagamento_id: 'pg-6', stato: 'sconosciuto' },
          { pagamento_id: 42, stato: 'in_coda' },
          null,
        ],
        error: null,
      }),
      OP,
    )
    expect([...mappa.entries()]).toEqual([
      ['pg-1', 'in_coda'],
      ['pg-2', 'in_invio'],
      ['pg-3', 'errore'],
    ])
    expect(h.logEvento).not.toHaveBeenCalled()
  })
})

describe('leggiCodaAttiva — la coda che non si legge', () => {
  it.each(['PGRST205', '42P01'])('coda assente (%s): mappa vuota e un info «coda-assente» con l\'errore', async (code) => {
    const errore = { code, message: 'relation does not exist' }
    const mappa = await leggiCodaAttiva(risponde({ data: null, error: errore }), OP)
    expect(mappa.size).toBe(0)
    expect(h.logEvento).toHaveBeenCalledTimes(1)
    expect(h.logEvento).toHaveBeenCalledWith('fattura', 'info', { operazione: OP, esito: 'coda-assente' }, errore)
  })

  it('un guasto vero (08006): mappa vuota e un warn «coda-badge-non-letta»', async () => {
    const errore = { code: '08006', message: 'connection failure' }
    const mappa = await leggiCodaAttiva(risponde({ data: null, error: errore }), OP)
    expect(mappa.size).toBe(0)
    expect(h.logEvento).toHaveBeenCalledWith('fattura', 'warn', { operazione: OP, esito: 'coda-badge-non-letta' }, errore)
    expect(esiti()).toEqual([['warn', 'coda-badge-non-letta']])
  })

  it('né dati né errore: mappa vuota e un warn «coda-badge-non-letta»', async () => {
    const mappa = await leggiCodaAttiva(risponde({ data: null, error: null }), OP)
    expect(mappa.size).toBe(0)
    expect(esiti()).toEqual([['warn', 'coda-badge-non-letta']])
  })

  it('chiedi che LANCIA: la promessa si risolve con la mappa vuota, e un warn «coda-badge-eccezione»', async () => {
    const guasto = new Error('rete giù')
    const mappa = await leggiCodaAttiva(() => {
      throw guasto
    }, OP)
    expect(mappa.size).toBe(0)
    expect(h.logEvento).toHaveBeenCalledWith('fattura', 'warn', { operazione: OP, esito: 'coda-badge-eccezione' }, guasto)
    expect(esiti()).toEqual([['warn', 'coda-badge-eccezione']])
  })

  it('chiedi che RIFIUTA la promessa: stessa sorte', async () => {
    const mappa = await leggiCodaAttiva(() => Promise.reject(new Error('rifiutata')), OP)
    expect(mappa.size).toBe(0)
    expect(esiti()).toEqual([['warn', 'coda-badge-eccezione']])
  })
})

describe('leggiCodaAttiva — il tetto di PostgREST', () => {
  it(`${MAX_RIGHE_CODA} righe: la mappa c'è, e un warn «coda-badge-troncato» con n`, async () => {
    expect(MAX_RIGHE_CODA).toBe(1000)
    const righe = Array.from({ length: 1000 }, (_, i) => ({ pagamento_id: `pg-${i}`, stato: 'in_coda' }))
    const mappa = await leggiCodaAttiva(risponde({ data: righe, error: null }), OP)
    expect(mappa.size).toBe(1000)
    expect(mappa.get('pg-0')).toBe('in_coda')
    expect(h.logEvento).toHaveBeenCalledWith('fattura', 'warn', { operazione: OP, esito: 'coda-badge-troncato', n: 1000 })
    expect(esiti()).toEqual([['warn', 'coda-badge-troncato']])
  })

  it('999 righe: nessun warn', async () => {
    const righe = Array.from({ length: 999 }, (_, i) => ({ pagamento_id: `pg-${i}`, stato: 'errore' }))
    const mappa = await leggiCodaAttiva(risponde({ data: righe, error: null }), OP)
    expect(mappa.size).toBe(999)
    expect(h.logEvento).not.toHaveBeenCalled()
  })
})
