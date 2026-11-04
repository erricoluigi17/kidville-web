import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import { logSchemaIndietro, scriviConRipiegoSchema, type RipiegoSchema } from '@/lib/db/colonna-assente'

/**
 * IL RIPIEGO A STADI (la regola che prima stava copiata in tre route).
 * Le «scritture» sono funzioni che restituiscono la forma di PostgREST, `{ data, error }`, e contano le chiamate.
 */

type Esito = { data: unknown; error: { code?: string; message?: string } | null }
const riuscita = (data: unknown = { id: 'riga' }): Esito => ({ data, error: null })
const respinta = (code: string): Esito => ({ data: null, error: { code, message: 'errore' } })

const OP = 'gruppo/route:POST'
const scrittura = (...esiti: Esito[]) => {
  const chiamate = vi.fn(async () => esiti[chiamate.mock.calls.length - 1] ?? riuscita())
  return chiamate
}
const ripiegoDi = (stadio: number, ...esiti: Esito[]): RipiegoSchema<Esito> & { chiamate: ReturnType<typeof vi.fn> } => {
  const chiamate = scrittura(...esiti)
  return { stadio, scrivi: chiamate, chiamate }
}
const ripiegiLogged = () =>
  h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'colonne-nuove-non-disponibili-schema')

beforeEach(() => {
  h.logEvento.mockClear()
})

describe('scriviConRipiegoSchema', () => {
  it('stadio 0: la scrittura intera riesce, i ripieghi non partono e non c’è nessun log', async () => {
    const prima = scrittura(riuscita({ id: 'intera' }))
    const r1 = ripiegoDi(1)
    const r2 = ripiegoDi(2)

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1, r2])

    expect(stadio).toBe(0)
    expect(esito).toEqual({ data: { id: 'intera' }, error: null })
    expect(prima).toHaveBeenCalledTimes(1)
    expect(r1.chiamate).not.toHaveBeenCalled()
    expect(r2.chiamate).not.toHaveBeenCalled()
    expect(ripiegiLogged()).toEqual([])
  })

  it('ripiego a 1: manca la colonna nuova (PGRST204), il primo ripiego riesce, un log con tentativo 1', async () => {
    const errore = respinta('PGRST204')
    const prima = scrittura(errore)
    const r1 = ripiegoDi(1, riuscita({ id: 'senza-periodo' }))
    const r2 = ripiegoDi(2)

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1, r2])

    expect(stadio).toBe(1)
    expect(esito).toEqual({ data: { id: 'senza-periodo' }, error: null })
    expect(r2.chiamate).not.toHaveBeenCalled()
    expect(ripiegiLogged()).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      { operazione: OP, esito: 'colonne-nuove-non-disponibili-schema', tentativo: 1 },
      errore.error,
    )
  })

  it('ripiego a 2: anche il primo ripiego torna un errore di schema (42703), riesce il secondo, log 1 e 2 in ordine', async () => {
    const e0 = respinta('PGRST204')
    const e1 = respinta('42703')
    const prima = scrittura(e0)
    const r1 = ripiegoDi(1, e1)
    const r2 = ripiegoDi(2, riuscita({ id: 'senza-nessuna' }))

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1, r2])

    expect(stadio).toBe(2)
    expect(esito).toEqual({ data: { id: 'senza-nessuna' }, error: null })
    expect(ripiegiLogged().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
    // Ogni ripiego lascia l'errore che l'ha provocato, non quello di un altro stadio.
    expect(ripiegiLogged().map(([, , , errore]) => errore)).toEqual([e0.error, e1.error])
  })

  it('un errore che NON è di schema non ripiega: torna com’è, senza ripieghi e senza log', async () => {
    const guasto = respinta('57014')
    const prima = scrittura(guasto)
    const r1 = ripiegoDi(1)

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1])

    expect(stadio).toBe(0)
    expect(esito).toBe(await prima.mock.results[0].value)
    expect(esito.error?.code).toBe('57014')
    expect(r1.chiamate).not.toHaveBeenCalled()
    expect(ripiegiLogged()).toEqual([])
  })

  it('un errore non di schema al ripiego 1 ferma la catena: il ripiego 2 non parte, lo stadio è 1', async () => {
    const prima = scrittura(respinta('PGRST204'))
    const r1 = ripiegoDi(1, respinta('23514'))
    const r2 = ripiegoDi(2)

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1, r2])

    expect(stadio).toBe(1)
    expect(esito.error?.code).toBe('23514')
    expect(r2.chiamate).not.toHaveBeenCalled()
    expect(ripiegiLogged()).toHaveLength(1)
  })

  it('anche l’ultimo ripiego fallisce con un errore di schema: l’errore torna al chiamante, che risponde 500', async () => {
    const prima = scrittura(respinta('PGRST204'))
    const r1 = ripiegoDi(1, respinta('PGRST204'))
    const r2 = ripiegoDi(2, respinta('PGRST204'))

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [r1, r2])

    expect(stadio).toBe(2)
    expect(esito.error?.code).toBe('PGRST204')
    expect(ripiegiLogged().map(([, , campi]) => campi.tentativo)).toEqual([1, 2])
  })

  it('senza ripieghi (un solo stadio) la scrittura intera torna così com’è, anche con un errore di schema', async () => {
    const { esito, stadio } = await scriviConRipiegoSchema(OP, scrittura(respinta('PGRST204')))

    expect(stadio).toBe(0)
    expect(esito?.error?.code).toBe('PGRST204')
    expect(ripiegiLogged()).toEqual([])
  })

  it('lo stadio è quello dichiarato dal ripiego, non la sua posizione: un ripiego «2» da solo logga tentativo 2', async () => {
    const prima = scrittura(respinta('42703'))
    const soloVecchia = ripiegoDi(2, riuscita())

    const { stadio } = await scriviConRipiegoSchema(OP, prima, [soloVecchia])

    expect(stadio).toBe(2)
    expect(ripiegiLogged().map(([, , campi]) => campi.tentativo)).toEqual([2])
  })

  it('un ripiego che non ha più niente da scrivere restituisce null e la catena si ferma', async () => {
    const prima = vi.fn(async (): Promise<Esito | null> => respinta('PGRST204'))
    const nulla: RipiegoSchema<Esito | null> = { stadio: 2, scrivi: async () => null }
    const dopo: RipiegoSchema<Esito | null> = { stadio: 3, scrivi: vi.fn(async () => riuscita()) }

    const { esito, stadio } = await scriviConRipiegoSchema(OP, prima, [nulla, dopo])

    expect(esito).toBeNull()
    expect(stadio).toBe(2)
    expect(dopo.scrivi).not.toHaveBeenCalled()
  })

  it('un’eccezione della scrittura non viene inghiottita', async () => {
    const prima = vi.fn(async () => {
      throw new Error('rete')
    })
    await expect(scriviConRipiegoSchema(OP, prima, [ripiegoDi(1)])).rejects.toThrow('rete')
  })
})

describe('logSchemaIndietro', () => {
  it('è l’evento di sempre: info, area registro, esito colonne-nuove-non-disponibili-schema e il numero del tentativo', () => {
    const errore = { code: 'PGRST204' }
    logSchemaIndietro('gruppo/route:PATCH', errore, 1)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      { operazione: 'gruppo/route:PATCH', esito: 'colonne-nuove-non-disponibili-schema', tentativo: 1 },
      errore,
    )
  })
})
