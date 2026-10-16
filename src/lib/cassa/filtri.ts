import type { CassaMetodo, CassaTipoMovimento, RigaMovimentoCassa } from './tipi'

export interface FiltriMovimentiCassa {
  tipo: CassaTipoMovimento | ''
  scuolaId: string
  da: string
  a: string
  categoriaId: string
  cassaId: string
  metodo: CassaMetodo | ''
  origine: RigaMovimentoCassa['origine'] | ''
  stato: '' | 'attivo' | 'stornato' | 'contromovimento'
  allegato: '' | 'presente' | 'assente'
  importoMin: string
  importoMax: string
  ricerca: string
}

export const FILTRI_CASSA_INIZIALI: Readonly<FiltriMovimentiCassa> = {
  tipo: '', scuolaId: '', da: '', a: '', categoriaId: '', cassaId: '', metodo: '', origine: '',
  stato: '', allegato: '', importoMin: '', importoMax: '', ricerca: '',
}

export type ErroreFiltriCassa = 'date' | 'importi'

const normalizza = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim()
const dataValida = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/** Il mese è una scorciatoia per da/a, mai un secondo intervallo nascosto. */
export function intervalloMeseCassa(mese: string): { da: string; a: string } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mese)) return null
  const da = `${mese}-01`
  if (!dataValida(da)) return null
  const fine = new Date(`${da}T00:00:00Z`)
  fine.setUTCMonth(fine.getUTCMonth() + 1, 0)
  return { da, a: fine.toISOString().slice(0, 10) }
}

function leggiImporto(s: string): number | null {
  if (!s.trim()) return null
  if (!/^\d+(?:[.,]\d+)?$/.test(s.trim())) return NaN
  return Number(s.trim().replace(',', '.'))
}

/**
 * Un unico insieme per tabella e card. I limiti d'importo confrontano il valore
 * assoluto, così un originale e il suo storno hanno la stessa grandezza.
 * Un filtro invalido restituisce solo l'errore, mai risultati apparentemente validi.
 */
export function filtraMovimentiCassa<T extends RigaMovimentoCassa>(
  righe: readonly T[], f: Readonly<FiltriMovimentiCassa>,
): { movimenti: T[]; errore: ErroreFiltriCassa | null } {
  if ((f.da && !dataValida(f.da)) || (f.a && !dataValida(f.a)) || (f.da && f.a && f.da > f.a)) {
    return { movimenti: [], errore: 'date' }
  }
  const min = leggiImporto(f.importoMin)
  const max = leggiImporto(f.importoMax)
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) || (min !== null && max !== null && min > max)) {
    return { movimenti: [], errore: 'importi' }
  }
  const ricerca = normalizza(f.ricerca)
  const movimenti = righe.filter(r => {
    if (f.tipo && r.tipo !== f.tipo) return false
    if (f.scuolaId && r.scuola_id !== f.scuolaId) return false
    if ((f.da && r.data < f.da) || (f.a && r.data > f.a)) return false
    if (f.categoriaId === '__nessuna__' ? r.categoria_id !== null : f.categoriaId && r.categoria_id !== f.categoriaId) return false
    if (f.cassaId === '__generale__' ? r.cassa_categoria_id != null : f.cassaId && r.cassa_categoria_id !== f.cassaId) return false
    if (f.metodo && r.metodo !== f.metodo) return false
    if (f.origine && r.origine !== f.origine) return false
    if (f.stato === 'attivo' && (r.stornato_il || r.storno_di)) return false
    if (f.stato === 'stornato' && !r.stornato_il) return false
    if (f.stato === 'contromovimento' && !r.storno_di) return false
    if (f.allegato === 'presente' && !r.allegato_path) return false
    if (f.allegato === 'assente' && r.allegato_path) return false
    const importo = Math.abs(r.importo)
    if ((min !== null && importo < min) || (max !== null && importo > max)) return false
    if (ricerca && !normalizza([r.descrizione, r.note, r.categoria_nome].filter(Boolean).join(' ')).includes(ricerca)) return false
    return true
  })
  return { movimenti, errore: null }
}
