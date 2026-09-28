import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})

import { leggiABlocchi, BLOCCO_LETTURA } from '@/lib/pagamenti/leggi-a-blocchi'

/**
 * `leggiABlocchi` (revisione 2026-09-28, C2) — l'export leggeva senza `range`, e PostgREST
 * taglia in silenzio a `max_rows` (1000). Qui una sorgente A COPIONE: registra ordini e
 * intervalli di ogni richiesta, e — come PostgREST — non restituisce mai più di `tetto` righe.
 */
function sorgente(totale: number, o: { tetto?: number; erroreAlBlocco?: number } = {}) {
  const righe = Array.from({ length: totale }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }))
  const richieste: { ordini: [string, boolean][]; range: [number, number] | null }[] = []
  const costruisci = () => {
    const r = { ordini: [] as [string, boolean][], range: null as [number, number] | null }
    richieste.push(r)
    const q = {
      order(colonna: string, opzioni?: { ascending?: boolean }) {
        r.ordini.push([colonna, opzioni?.ascending !== false])
        return q
      },
      range(da: number, a: number) {
        r.range = [da, a]
        if (o.erroreAlBlocco !== undefined && richieste.length - 1 === o.erroreAlBlocco) {
          return Promise.resolve({ data: null, error: { code: '57014', message: 'timeout' } })
        }
        const pagina = righe.slice(da, a + 1).slice(0, o.tetto ?? Infinity)
        return Promise.resolve({ data: pagina, error: null })
      },
    }
    return q
  }
  return { costruisci, richieste }
}

const O = { operazione: 'test:GET', tipo: 'prova' }

beforeEach(() => h.logEvento.mockClear())

describe('leggiABlocchi', () => {
  it('il blocco è il max_rows di PostgREST (1000): più grande, un blocco tagliato sembrerebbe corto', () => {
    expect(BLOCCO_LETTURA).toBe(1000)
  })

  it('2.500 righe dietro un tetto di 1000: le legge TUTTE, in tre blocchi, fino al primo corto', async () => {
    const s = sorgente(2500, { tetto: 1000 })
    const e = await leggiABlocchi<{ id: string }>(s.costruisci, O)
    expect(e.ok && e.righe.length).toBe(2500)
    expect(e.ok && new Set(e.righe.map((r) => r.id)).size).toBe(2500)
    expect(s.richieste.map((r) => r.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(e.ok && e.troncata).toBe(false)
  })

  it('un multiplo esatto del blocco: un blocco vuoto in più, e basta', async () => {
    const s = sorgente(2000, { tetto: 1000 })
    const e = await leggiABlocchi(s.costruisci, O)
    expect(e.ok && e.righe.length).toBe(2000)
    expect(s.richieste).toHaveLength(3)
  })

  it('ogni blocco è ordinato: prima l’ordine del chiamante, poi `id` (fra pari scadenza Postgres non garantisce l’ordine)', async () => {
    const s = sorgente(1500, { tetto: 1000 })
    await leggiABlocchi(() => s.costruisci().order('scadenza', { ascending: true }), O)
    for (const r of s.richieste) expect(r.ordini).toEqual([['scadenza', true], ['id', true]])
  })

  it('un blocco che fallisce fa fallire la lettura: niente mezza tabella spacciata per intera', async () => {
    const s = sorgente(2500, { tetto: 1000, erroreAlBlocco: 1 })
    const e = await leggiABlocchi(s.costruisci, O)
    expect(e.ok).toBe(false)
    expect(!e.ok && e.error).toMatchObject({ code: '57014' })
  })

  it('al tetto dei blocchi, con altro oltre: esce ciò che ha letto, troncata=true e un log ERROR (solo conteggi)', async () => {
    const s = sorgente(7)
    const e = await leggiABlocchi<{ id: string }>(s.costruisci, { ...O, blocco: 2, maxBlocchi: 3 })
    expect(e.ok && e.righe.length).toBe(6)
    expect(e.ok && e.troncata).toBe(true)
    // La prova è UNA riga, subito dopo l'ultimo blocco pieno.
    expect(s.richieste.at(-1)?.range).toEqual([6, 6])
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({
      operazione: 'test:GET', esito: 'lettura-troncata', tipo: 'prova', n: 6, blocchi: 4,
    }))
  })

  it('al tetto dei blocchi, ma esattamente pieno: completa, nessun allarme falso', async () => {
    const s = sorgente(6)
    const e = await leggiABlocchi(s.costruisci, { ...O, blocco: 2, maxBlocchi: 3 })
    expect(e.ok && e.righe.length).toBe(6)
    expect(e.ok && e.troncata).toBe(false)
    expect(h.logEvento).not.toHaveBeenCalled()
  })
})
