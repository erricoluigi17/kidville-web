import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// `annullaRicevutaTransazioneAttiva` — l'annullo della ricevuta di famiglia quando
// si annulla una transazione. È best-effort e NON deve mai lanciare (l'annullo
// della transazione non può fallire per la ricevuta), ma fino al Task 7 era un
// `try { await … } catch {}` che ingoiava tutto: e siccome PostgREST non lancia,
// ritorna `{ error }`, il `catch` non scattava nemmeno. Un registro assente e un
// guasto vero erano lo stesso silenzio.
//
// Il test di `transazioni-annulla` mocka l'intero modulo `ricevute`: questa
// funzione si collauda qui, contro un finto Supabase pilotato.

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  errore: null as { code: string; message: string } | null,
  lancia: false,
  chiamate: [] as { table: string; row: Record<string, unknown>; eq: [string, unknown][]; is: [string, unknown][] }[],
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { annullaRicevutaTransazioneAttiva } from '@/lib/pagamenti/ricevute'

const TX = '22222222-2222-4222-8222-222222222222'
const DA = '33333333-3333-4333-8333-333333333333'
const MOTIVO = 'bonifico abbinato per sbaglio'

function finto(): SupabaseClient {
  return {
    from: (table: string) => {
      if (h.lancia) throw new Error('rete giù')
      return {
        update: (row: Record<string, unknown>) => {
          const c = { table, row, eq: [] as [string, unknown][], is: [] as [string, unknown][] }
          h.chiamate.push(c)
          const u: Record<string, unknown> = {}
          u.eq = (col: string, v: unknown) => { c.eq.push([col, v]); return u }
          u.is = (col: string, v: unknown) => { c.is.push([col, v]); return u }
          u.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: h.errore })
          return u
        },
      }
    },
  } as unknown as SupabaseClient
}

const eventi = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.errore = null
  h.lancia = false
  h.chiamate = []
})

describe('annullaRicevutaTransazioneAttiva — gli errori non sono più muti', () => {
  it('percorso pulito → annulla SOLO la ricevuta attiva della transazione, nessun log d\'errore', async () => {
    await expect(annullaRicevutaTransazioneAttiva(finto(), TX, { da: DA, motivo: MOTIVO })).resolves.toBeUndefined()
    expect(h.chiamate).toHaveLength(1)
    const c = h.chiamate[0]
    expect(c.table).toBe('ricevute_emesse')
    expect(c.row).toMatchObject({ annullata_da: DA, annullo_motivo: MOTIVO })
    expect(typeof c.row.annullata_il).toBe('string')
    expect(c.eq).toEqual([['transazione_id', TX]])
    expect(c.is).toEqual([['annullata_il', null]])
    expect(eventi('ricevute-registro-assente')).toEqual([])
    expect(eventi('ricevuta-non-annullata')).toEqual([])
  })

  it('registro assente (42P01, DB non migrato) → non lancia, logEvento info «ricevute-registro-assente»', async () => {
    h.errore = { code: '42P01', message: 'relation "ricevute_emesse" does not exist' }
    await expect(annullaRicevutaTransazioneAttiva(finto(), TX, { motivo: MOTIVO })).resolves.toBeUndefined()
    const righe = eventi('ricevute-registro-assente')
    expect(righe).toHaveLength(1)
    const [evento, livello, campi, err] = righe[0]
    expect(evento).toBe('pagamento')
    expect(livello).toBe('info')
    expect(campi).toMatchObject({ operazione: 'ricevute:annulla-transazione', transazione_id: TX })
    expect(err).toMatchObject({ code: '42P01' })
    expect(eventi('ricevuta-non-annullata')).toEqual([])
  })

  it('guasto vero (XX000) → non lancia, logEvento error «ricevuta-non-annullata», senza il motivo', async () => {
    h.errore = { code: 'XX000', message: 'internal error' }
    await expect(annullaRicevutaTransazioneAttiva(finto(), TX, { da: DA, motivo: MOTIVO })).resolves.toBeUndefined()
    const righe = eventi('ricevuta-non-annullata')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect(righe[0][2]).toMatchObject({ operazione: 'ricevute:annulla-transazione', transazione_id: TX })
    expect(righe[0][3]).toMatchObject({ code: 'XX000' })
    expect(JSON.stringify(righe[0][2])).not.toContain(MOTIVO)
    expect(eventi('ricevute-registro-assente')).toEqual([])
  })

  it('il client LANCIA → non lancia a sua volta, logEvento error «ricevuta-non-annullata»', async () => {
    h.lancia = true
    await expect(annullaRicevutaTransazioneAttiva(finto(), TX, { motivo: MOTIVO })).resolves.toBeUndefined()
    const righe = eventi('ricevuta-non-annullata')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect(righe[0][2]).toMatchObject({ transazione_id: TX })
  })
})
