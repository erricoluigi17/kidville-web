import { describe, it, expect } from 'vitest'
import * as daDb from '@/lib/db/leggi-a-blocchi'
import type { QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
import * as daPagamenti from '@/lib/pagamenti/leggi-a-blocchi'

/**
 * `leggiABlocchi` in `src/lib/db/` (robustezza 2, sessione 11).
 *
 * Due cose da provare. La prima: lo spostamento non cambia niente per chi importava dal percorso
 * dei pagamenti — gli oggetti sono GLI STESSI. La seconda: ogni blocco si ordina per una chiave
 * UNICA. Senza, Postgres restituisce i pari (stessa `created_at`, stesso `student_id`) in un
 * ordine qualunque, diverso da una richiesta all'altra, e due blocchi `range` consecutivi si
 * sovrappongono: righe doppie da una parte, righe perse dall'altra.
 */

type Riga = Record<string, string>

/**
 * Una sorgente che si comporta come Postgres: ordina per le colonne chieste e, fra righe pari su
 * quelle colonne, restituisce un ordine qualunque — qui il caso peggiore e ripetibile, l'ordine
 * rovesciato a ogni richiesta dispari (`sort` è stabile, quindi i pari restano nell'ordine della
 * base). Con una chiave unica i pari non esistono, e i blocchi combaciano.
 */
function sorgenteCheRimescola(righe: readonly Riga[]) {
  let richieste = 0
  const ordini: string[][] = []
  const costruisci = (): QueryABlocchi => {
    const n = richieste++
    const chieste: string[] = []
    ordini.push(chieste)
    const q: QueryABlocchi = {
      order(colonna: string) {
        chieste.push(colonna)
        return q
      },
      range(da: number, a: number) {
        const base = n % 2 === 0 ? [...righe] : [...righe].reverse()
        base.sort((x, y) => {
          for (const c of chieste) {
            const d = (x[c] ?? '').localeCompare(y[c] ?? '')
            if (d !== 0) return d
          }
          return 0
        })
        return Promise.resolve({ data: base.slice(da, a + 1), error: null })
      },
    }
    return q
  }
  return { costruisci, ordini }
}

/** Quattro alunni, due genitori ciascuno: la forma di `student_parents`, che non ha `id`. */
const LEGAMI: Riga[] = ['s0', 's1', 's2', 's3'].flatMap((s) =>
  ['p0', 'p1'].map((p) => ({ student_id: s, parent_id: p })),
)
const coppia = (r: Riga) => `${r.student_id}|${r.parent_id}`

describe('leggiABlocchi in `src/lib/db/` — sposta e riesporta', () => {
  it('il modulo dei pagamenti riesporta GLI STESSI oggetti: chi lo importava non cambia', () => {
    expect(daPagamenti.leggiABlocchi).toBe(daDb.leggiABlocchi)
    expect(daPagamenti.descriviTetto).toBe(daDb.descriviTetto)
    expect(daPagamenti.BLOCCO_LETTURA).toBe(daDb.BLOCCO_LETTURA)
    expect(daPagamenti.MAX_BLOCCHI_LETTURA).toBe(daDb.MAX_BLOCCHI_LETTURA)
  })
})

describe('leggiABlocchi — ogni blocco è ordinato per una chiave UNICA', () => {
  it('CONTROLLO: con una chiave che non è unica la sorgente perde e raddoppia righe (il test vede il difetto)', async () => {
    const s = sorgenteCheRimescola(LEGAMI)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3, chiave: ['student_id'] })
    expect(e.ok).toBe(true)
    const lette = e.ok ? e.righe.map(coppia) : []
    expect(lette).toHaveLength(LEGAMI.length)
    expect(new Set(lette).size).toBeLessThan(LEGAMI.length)
  })

  it('`student_parents` con la sua chiave primaria (student_id, parent_id): ogni coppia, una volta sola', async () => {
    const s = sorgenteCheRimescola(LEGAMI)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3, chiave: ['student_id', 'parent_id'] })
    const lette = e.ok ? e.righe.map(coppia) : []
    expect(lette).toHaveLength(LEGAMI.length)
    expect(new Set(lette)).toEqual(new Set(LEGAMI.map(coppia)))
    for (const o of s.ordini) expect(o).toEqual(['student_id', 'parent_id'])
  })

  it('senza `chiave` resta `id`, in coda all’ordine del chiamante: com’era prima dello spostamento', async () => {
    const righe = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, created_at: '2026-10-20T08:00:00.000Z' }))
    const s = sorgenteCheRimescola(righe)
    const e = await daDb.leggiABlocchi<Riga>(() => s.costruisci().order('created_at'), { blocco: 3 })
    expect(e.ok && e.righe.map((r) => r.id)).toEqual(righe.map((r) => r.id))
    for (const o of s.ordini) expect(o).toEqual(['created_at', 'id'])
  })

  it('una `chiave` vuota non toglie l’ordine: si torna a `id`', async () => {
    const righe = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }))
    const s = sorgenteCheRimescola(righe)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 2, chiave: [] })
    expect(e.ok && e.righe).toHaveLength(5)
    for (const o of s.ordini) expect(o).toEqual(['id'])
  })
})
