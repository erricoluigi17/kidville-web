import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// PR 4.3 · 4.3.5 · l'ORDINE delle due scritture `alunni` ↔ `frequenze` in fase B (`src/lib/anno/scrittura.ts`).
// a) fase B: prima la frequenza, poi alunni · b) frequenza fallita → alunni NON toccata (fail-closed)
// c) interruttore spento = fase A (alunni, poi frequenza) · d) codice dell'anno → 422 · e) lotto con una riga che fallisce
// f) colonna dell'interruttore assente (42703) → fase A, senza logErrore.
// =============================================================================

const h = vi.hoisted(() => ({
  ordine: [] as string[],
  scriviFrequenza: vi.fn(),
  logErrore: vi.fn(),
  regole: { data: { specchio_frequenze_attivo: true }, error: null } as { data: unknown; error: { code?: string } | null },
}))

vi.mock('@/lib/anno/frequenze', async (orig) => ({
  ...(await orig<typeof import('@/lib/anno/frequenze')>()),
  scriviFrequenza: h.scriviFrequenza,
}))
vi.mock('@/lib/logging/logger', () => ({ logErrore: h.logErrore, logOk: vi.fn(), logEvento: vi.fn() }))

import { conFaseB, scriviAlunnoEFrequenza } from '@/lib/anno/scrittura'
import { rispostaFrequenzaNonScritta } from '@/lib/anno/errori'
import { annoAttivoDiSede } from '@/lib/anno/frequenze'

const ANNO_SEDE = '22222222-2222-4222-8222-222222222222'
const ALU = '11111111-1111-4111-8111-111111111111'

function finto(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({ limit: () => ({ maybeSingle: async () => h.regole }) }),
    }),
  } as unknown as SupabaseClient
}

const args = { alunnoId: ALU, annoSedeId: ANNO_SEDE, campi: { sospeso: true } as never }
const scriviAlunni = vi.fn(async () => {
  h.ordine.push('alunni')
  return { data: null, error: null }
})

beforeEach(() => {
  h.ordine.length = 0
  h.scriviFrequenza.mockReset()
  h.scriviFrequenza.mockImplementation(async () => {
    h.ordine.push('frequenza')
    return { ok: true }
  })
  h.logErrore.mockClear()
  scriviAlunni.mockClear()
  h.regole = { data: { specchio_frequenze_attivo: true }, error: null }
})

describe('scriviAlunnoEFrequenza', () => {
  it('(a) fase B: PRIMA la frequenza, POI alunni', async () => {
    const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
    expect(r.scritto).toBe(true)
    expect(h.ordine).toEqual(['frequenza', 'alunni'])
  })

  it('(b) fase B, frequenza non scritta: alunni NON toccata, 500 FREQUENZA_NON_SCRITTA', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
    const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
    expect(r).toEqual({ scritto: false, codice: 'SCRITTURA_FALLITA' })
    expect(scriviAlunni).not.toHaveBeenCalled()
    const risposta = rispostaFrequenzaNonScritta('SCRITTURA_FALLITA')
    expect(risposta.status).toBe(500)
    expect((await risposta.json()).codice).toBe('FREQUENZA_NON_SCRITTA')
    expect(h.logErrore).toHaveBeenCalledTimes(1)
  })

  it('(c) interruttore spento = fase A: alunni, poi la frequenza', async () => {
    h.regole = { data: { specchio_frequenze_attivo: false }, error: null }
    const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
    expect(r.scritto).toBe(true)
    expect(h.ordine).toEqual(['alunni', 'frequenza'])
  })

  it('(c bis) fase A, alunni in errore: la frequenza non si scrive', async () => {
    h.regole = { data: { specchio_frequenze_attivo: false }, error: null }
    await scriviAlunnoEFrequenza(finto(), args, async () => ({ data: null, error: { code: 'X' } }))
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  it('(d) codice dell’anno: alunni non toccata e la risposta è 422, senza logErrore', async () => {
    h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'ANNO_NON_COERENTE' })
    const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
    expect(r).toEqual({ scritto: false, codice: 'ANNO_NON_COERENTE' })
    expect(scriviAlunni).not.toHaveBeenCalled()
    expect(rispostaFrequenzaNonScritta('ANNO_NON_COERENTE').status).toBe(422)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('(e) lotto: una riga che fallisce non ferma le altre', async () => {
    const altro = '11111111-1111-4111-8111-222222222222'
    h.scriviFrequenza.mockImplementation(async (_s: unknown, a: { alunnoId: string }) =>
      a.alunnoId === ALU ? { ok: false, codice: 'SCRITTURA_FALLITA' } : { ok: true },
    )
    const c = finto()
    const esiti = []
    for (const id of [ALU, altro]) esiti.push(await scriviAlunnoEFrequenza(c, { ...args, alunnoId: id }, scriviAlunni))
    expect(esiti.map((e) => e.scritto)).toEqual([false, true])
    expect(scriviAlunni).toHaveBeenCalledTimes(1)
  })

  it('(f) colonna dell’interruttore assente (42703): fase A, e nessun logErrore', async () => {
    h.regole = { data: null, error: { code: '42703' } }
    const c = finto()
    expect(await conFaseB(c)).toBe(false)
    const r = await scriviAlunnoEFrequenza(c, args, scriviAlunni)
    expect(r.scritto).toBe(true)
    expect(h.ordine).toEqual(['alunni', 'frequenza'])
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('senza anno attivo (annoSedeId null): solo alunni, mai la frequenza', async () => {
    const r = await scriviAlunnoEFrequenza(finto(), { ...args, annoSedeId: null }, scriviAlunni)
    expect(r.scritto).toBe(true)
    expect(h.scriviFrequenza).not.toHaveBeenCalled()
  })

  describe('lettura di anno_attivo (null ambiguo)', () => {
    const conRpc = (esito: { data: unknown; error: { code?: string } | null } | 'lancia'): SupabaseClient =>
      ({
        ...(finto() as unknown as object),
        rpc: async () => {
          if (esito === 'lancia') throw new Error('rete')
          return esito
        },
      }) as unknown as SupabaseClient

    it('fase B, guasto di anno_attivo: rifiuto, alunni NON scritta', async () => {
      const c = conRpc({ data: null, error: { code: 'XX000' } })
      const anno = await annoAttivoDiSede(c, 'sede-1')
      expect(anno).toBeNull()
      const r = await scriviAlunnoEFrequenza(c, { ...args, annoSedeId: anno }, scriviAlunni)
      expect(r).toEqual({ scritto: false, codice: 'SCRITTURA_FALLITA' })
      expect(scriviAlunni).not.toHaveBeenCalled()
      expect(rispostaFrequenzaNonScritta('SCRITTURA_FALLITA').status).toBe(500)
    })

    it('fase B, rpc che lancia: stesso rifiuto', async () => {
      const c = conRpc('lancia')
      const anno = await annoAttivoDiSede(c, 'sede-1')
      const r = await scriviAlunnoEFrequenza(c, { ...args, annoSedeId: anno }, scriviAlunni)
      expect(r.scritto).toBe(false)
      expect(scriviAlunni).not.toHaveBeenCalled()
    })

    it('fase B, schema indietro (PGRST202): alunni scritta, niente frequenza', async () => {
      const c = conRpc({ data: null, error: { code: 'PGRST202' } })
      const anno = await annoAttivoDiSede(c, 'sede-1')
      const r = await scriviAlunnoEFrequenza(c, { ...args, annoSedeId: anno }, scriviAlunni)
      expect(r.scritto).toBe(true)
      expect(scriviAlunni).toHaveBeenCalledTimes(1)
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
    })

    it('fase B, sede senza anno attivo (data null): alunni scritta', async () => {
      const c = conRpc({ data: null, error: null })
      const anno = await annoAttivoDiSede(c, 'sede-1')
      const r = await scriviAlunnoEFrequenza(c, { ...args, annoSedeId: anno }, scriviAlunni)
      expect(r.scritto).toBe(true)
    })

    it('fase A, guasto di anno_attivo: alunni scritta come sempre', async () => {
      h.regole = { data: { specchio_frequenze_attivo: false }, error: null }
      const c = conRpc({ data: null, error: { code: 'XX000' } })
      const anno = await annoAttivoDiSede(c, 'sede-1')
      const r = await scriviAlunnoEFrequenza(c, { ...args, annoSedeId: anno }, scriviAlunni)
      expect(r.scritto).toBe(true)
    })
  })
})
