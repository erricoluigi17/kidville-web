import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// PR 4.3 · 4.3.5 · l'ORDINE delle due scritture `alunni` ↔ `frequenze` in fase B (`src/lib/anno/scrittura.ts`).
// a) fase B: prima la frequenza, poi alunni · b) frequenza fallita → alunni NON toccata (fail-closed)
// c) interruttore spento = fase A (alunni, poi frequenza) · d) codice dell'anno → 422 · e) lotto con una riga che fallisce
// f) colonna dell'interruttore assente (42703) → fase A, senza logErrore.
// g) guasto di lettura dell'interruttore (non schema assente) → fase B, con logErrore: la frequenza si scrive per prima
//    e se il database è giù la risposta è un errore onesto · h) alunni fallisce DOPO la frequenza → segnale + log dedicato.
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

  describe('(g) guasto di lettura dell’interruttore: NON è la fase A', () => {
    it('errore che non è schema assente → fase B e logErrore col solo codice', async () => {
      h.regole = { data: null, error: { code: 'XX000' } }
      const c = finto()
      expect(await conFaseB(c)).toBe(true)
      expect(h.logErrore).toHaveBeenCalledTimes(1)
      const r = await scriviAlunnoEFrequenza(c, args, scriviAlunni)
      expect(r.scritto).toBe(true)
      expect(h.ordine).toEqual(['frequenza', 'alunni'])
    })

    it('con il database giù la frequenza fallisce per prima e alunni NON si tocca', async () => {
      h.regole = { data: null, error: { code: '57014' } }
      h.scriviFrequenza.mockResolvedValue({ ok: false, codice: 'SCRITTURA_FALLITA' })
      const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
      expect(r).toEqual({ scritto: false, codice: 'SCRITTURA_FALLITA' })
      expect(scriviAlunni).not.toHaveBeenCalled()
    })

    it('il client che lancia → fase B e logErrore', async () => {
      const lancia = { from: () => { throw new Error('rete') } } as unknown as SupabaseClient
      expect(await conFaseB(lancia)).toBe(true)
      expect(h.logErrore).toHaveBeenCalledTimes(1)
    })

    it.each(['42703', '42P01', 'PGRST204', 'PGRST205'])('schema assente (%s) → fase A, nessun logErrore', async (code) => {
      h.regole = { data: null, error: { code } }
      expect(await conFaseB(finto())).toBe(false)
      expect(h.logErrore).not.toHaveBeenCalled()
    })
  })

  describe('(h) alunni fallisce dopo la frequenza', () => {
    const fallisce = vi.fn(async () => {
      h.ordine.push('alunni')
      return { data: null, error: { code: '23505' } }
    })

    it('segnale frequenzaGiaScritta e un log dedicato con i soli uuid e il codice', async () => {
      const r = await scriviAlunnoEFrequenza(finto(), args, fallisce)
      expect(h.ordine).toEqual(['frequenza', 'alunni'])
      expect(r).toMatchObject({ scritto: true, frequenzaGiaScritta: true })
      const dedicati = h.logErrore.mock.calls.filter((c) => c[0]?.operazione === 'anno/fase-b:alunni-non-scritto')
      expect(dedicati).toHaveLength(1)
      const msg = String((dedicati[0][1] as Error).message)
      expect(msg).toContain('23505')
      expect(msg).toContain(ALU)
      expect(msg).toContain(ANNO_SEDE)
    })

    it('alunni riuscita: nessun segnale e nessun log', async () => {
      const r = await scriviAlunnoEFrequenza(finto(), args, scriviAlunni)
      expect(r).not.toHaveProperty('frequenzaGiaScritta')
      expect(h.logErrore).not.toHaveBeenCalled()
    })

    it.each([
      ['anno non attivo (saltata)', { ok: true, saltata: 'anno-non-attivo' }],
      ['schema indietro (saltata)', { ok: true, saltata: 'schema-indietro' }],
    ])('frequenza %s: niente è stato scritto, quindi nessun segnale', async (_nome, esito) => {
      h.scriviFrequenza.mockResolvedValue(esito)
      const r = await scriviAlunnoEFrequenza(finto(), args, fallisce)
      expect(r).toMatchObject({ scritto: true })
      expect(r).not.toHaveProperty('frequenzaGiaScritta')
      expect(h.logErrore).not.toHaveBeenCalled()
    })

    it('nessun campo da scrivere in frequenza: nessun segnale', async () => {
      const r = await scriviAlunnoEFrequenza(finto(), { ...args, campi: {} }, fallisce)
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
      expect(r).not.toHaveProperty('frequenzaGiaScritta')
    })

    it('fase A: alunni fallita, la frequenza non si scrive e non c’è segnale', async () => {
      h.regole = { data: { specchio_frequenze_attivo: false }, error: null }
      const r = await scriviAlunnoEFrequenza(finto(), args, fallisce)
      expect(h.scriviFrequenza).not.toHaveBeenCalled()
      expect(r).not.toHaveProperty('frequenzaGiaScritta')
    })
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
