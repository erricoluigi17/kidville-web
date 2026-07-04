/**
 * Raggruppamento pagamenti per categoria per la vista genitore (DL-022).
 * Funzione PURA: separa per `payment_categories.nome` (fallback "Altro", in coda)
 * e dentro ogni gruppo splitta da-pagare / pagati.
 */
export interface PagamentoCategorizzabile {
  stato: string
  payment_categories?: { nome?: string; colore?: string; icona?: string } | null
}

export interface GruppoCategoria<T> {
  categoria: string
  icona?: string
  colore?: string
  daPagare: T[]
  pagati: T[]
}

const ALTRO = 'Altro'

export function raggruppaPerCategoria<T extends PagamentoCategorizzabile>(
  pagamenti: T[]
): GruppoCategoria<T>[] {
  const mappa = new Map<string, GruppoCategoria<T>>()

  for (const p of pagamenti) {
    const cat = p.payment_categories?.nome || ALTRO
    if (!mappa.has(cat)) {
      mappa.set(cat, {
        categoria: cat,
        icona: p.payment_categories?.icona,
        colore: p.payment_categories?.colore,
        daPagare: [],
        pagati: [],
      })
    }
    const g = mappa.get(cat)!
    if (p.stato === 'pagato') g.pagati.push(p)
    else g.daPagare.push(p)
  }

  const gruppi = [...mappa.values()]
  // "Altro" sempre in coda, il resto in ordine di prima comparsa.
  return gruppi.sort((a, b) => {
    if (a.categoria === ALTRO) return 1
    if (b.categoria === ALTRO) return -1
    return 0
  })
}
