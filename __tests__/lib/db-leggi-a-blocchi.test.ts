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
  // Fino al 25/10 questo controllo passava da `leggiABlocchi` con `chiave: ['student_id']`. Da
  // quando la chiave serve anche a togliere i doppioni, una chiave non unica scarta righe vere per
  // conto suo, e il controllo non direbbe più niente della SORGENTE: si pagina a mano, con le
  // stesse richieste (blocco 3, intervalli 0-2, 3-5, 6-8) che `leggiABlocchi` faceva.
  it('CONTROLLO: ordinata per una chiave che non è unica, la sorgente perde e raddoppia righe fra due blocchi (il test vede il difetto)', async () => {
    const s = sorgenteCheRimescola(LEGAMI)
    const lette: string[] = []
    for (let da = 0; da < LEGAMI.length; da += 3) {
      const { data } = await s.costruisci().order('student_id').range(da, da + 2)
      lette.push(...(data as Riga[]).map(coppia))
    }
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

/**
 * Una sorgente che CAMBIA fra due pagine, come una tabella in uso: prima della richiesta numero
 * `dopo` (contando da 0) entra `nuova`, e tutto si riordina per le colonne chieste. Se `nuova`
 * cade prima del punto già letto, la paginazione per offset ripete in testa alla pagina dopo
 * l'ultima riga della pagina prima.
 */
function sorgenteCheCambia(iniziali: readonly Riga[], inserimento: { dopo: number; nuova: Riga }) {
  const righe = [...iniziali]
  const intervalli: [number, number][] = []
  const costruisci = (): QueryABlocchi => {
    const chieste: string[] = []
    const q: QueryABlocchi = {
      order(colonna: string) {
        chieste.push(colonna)
        return q
      },
      range(da: number, a: number) {
        if (intervalli.length === inserimento.dopo) righe.push(inserimento.nuova)
        intervalli.push([da, a])
        const ordinate = [...righe].sort((x, y) => {
          for (const c of chieste) {
            const d = (x[c] ?? '').localeCompare(y[c] ?? '')
            if (d !== 0) return d
          }
          return 0
        })
        return Promise.resolve({ data: ordinate.slice(da, a + 1), error: null })
      },
    }
    return q
  }
  return { costruisci, intervalli }
}

type RigaLibera = Record<string, string | null>

/** Una sorgente a copione: la richiesta `n` riceve `pagine[n]` (vuota oltre la fine). */
function sorgenteAPagine(pagine: readonly RigaLibera[][]) {
  let n = 0
  const costruisci = (): QueryABlocchi => {
    const q: QueryABlocchi = {
      order: () => q,
      range: () => Promise.resolve({ data: pagine[n++] ?? [], error: null }),
    }
    return q
  }
  return { costruisci }
}

describe('leggiABlocchi — i doppioni fra due pagine (paginazione per offset)', () => {
  it('una riga inserita fra due pagine ripete l’ultima letta: esce una volta sola, e la pagina piena col doppione non ferma la lettura', async () => {
    const iniziali = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((id) => ({ id }))
    const s = sorgenteCheCambia(iniziali, { dopo: 1, nuova: { id: 'a0' } })
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3 })
    expect(e.ok).toBe(true)
    // La sorgente ha davvero ripetuto `a3` (prima riga della seconda pagina): senza questo il
    // test non proverebbe niente.
    expect(s.intervalli).toEqual([[0, 2], [3, 5], [6, 8]])
    // Prima la prima occorrenza, nell'ordine d'arrivo; `a0` è entrata dietro il punto già letto
    // (è il limite dell'offset, non un doppione). `a6` e `a7` ci sono: la seconda pagina era
    // piena (3 righe arrivate, 2 nuove) e la lettura è andata avanti.
    expect(e.ok && e.righe.map((r) => r.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])
  })

  it('chiave composta: il doppione è la COPPIA ripetuta, non due legami con lo stesso alunno', async () => {
    const iniziali: Riga[] = [
      { student_id: 's0', parent_id: 'p1' },
      { student_id: 's1', parent_id: 'p0' },
      { student_id: 's1', parent_id: 'p1' },
      { student_id: 's2', parent_id: 'p0' },
      { student_id: 's2', parent_id: 'p1' },
      { student_id: 's3', parent_id: 'p0' },
    ]
    const s = sorgenteCheCambia(iniziali, { dopo: 1, nuova: { student_id: 's0', parent_id: 'p0' } })
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci, { blocco: 3, chiave: ['student_id', 'parent_id'] })
    // `s1|p1` arriva due volte (fine della prima pagina, inizio della seconda) ed esce una; i
    // legami che hanno in comune solo `student_id` restano tutti.
    expect(e.ok && e.righe.map(coppia)).toEqual(['s0|p1', 's1|p0', 's1|p1', 's2|p0', 's2|p1', 's3|p0'])
  })

  it('una riga che non porta il valore della chiave passa così com’è, senza fallire', async () => {
    const s = sorgenteAPagine([
      // Il `select` del chiamante non ha `id`: le due righe uguali non si possono dire doppioni.
      [{ nome: 'x' }, { nome: 'y' }, { id: null, nome: 'z' }],
      [{ id: null, nome: 'z' }, { nome: 'x' }],
    ])
    const e = await daDb.leggiABlocchi<RigaLibera>(s.costruisci, { blocco: 3 })
    expect(e.ok && e.righe.map((r) => r.nome)).toEqual(['x', 'y', 'z', 'z', 'x'])

    // Chiave composta con una colonna assente: stessa regola, la riga passa.
    const t = sorgenteAPagine([
      [{ student_id: 's1' }, { student_id: 's1', parent_id: 'p1' }],
    ])
    const f = await daDb.leggiABlocchi<RigaLibera>(t.costruisci, { blocco: 3, chiave: ['student_id', 'parent_id'] })
    expect(f.ok && f.righe).toEqual([{ student_id: 's1' }, { student_id: 's1', parent_id: 'p1' }])
    const u = sorgenteAPagine([[{ student_id: 's1' }, { student_id: 's1' }]])
    const g = await daDb.leggiABlocchi<RigaLibera>(u.costruisci, { blocco: 3, chiave: ['student_id', 'parent_id'] })
    expect(g.ok && g.righe).toHaveLength(2)
  })

  it('nessun doppione: il risultato è identico a prima, le stesse righe nello stesso ordine', async () => {
    const righe = Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }))
    const pagine = [righe.slice(0, 1000), righe.slice(1000, 2000), righe.slice(2000)]
    const s = sorgenteAPagine(pagine)
    const e = await daDb.leggiABlocchi<Riga>(s.costruisci)
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.blocchi).toBe(3)
    expect(e.righe).toHaveLength(righe.length)
    // Gli STESSI oggetti, non copie: la deduplica non tocca le righe che lascia passare.
    e.righe.forEach((r, i) => expect(r).toBe(righe[i]))
  })
})
