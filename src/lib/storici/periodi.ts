import { annoDelGiorno, inizioAnno, type Calendario } from '@/lib/anno-scolastico'

export type PeriodoStorico = 'giorno' | 'settimana' | 'mese' | 'anno' | 'tutto'
/**
 * `calendario`: quello della sede. Per `'anno'`, `dal` è l'inizio dell'anno di `oggi` (predefinito: il 1° settembre).
 */
export function periodoStorico(
  tipo: PeriodoStorico,
  oggi: string,
  calendario?: Calendario | null,
): { dal: string; al: string } {
  const [anno, mese, giorno] = oggi.split('-').map(Number)
  if (tipo === 'tutto') return { dal: '1900-01-01', al: oggi }
  if (tipo === 'giorno') return { dal: oggi, al: oggi }
  if (tipo === 'mese') return { dal: `${oggi.slice(0, 7)}-01`, al: oggi }
  if (tipo === 'anno') {
    const riga = annoDelGiorno(oggi, calendario)
    return { dal: riga.riga?.inizio ?? inizioAnno(riga.annoInizio), al: oggi }
  }
  const data = new Date(Date.UTC(anno, mese - 1, giorno))
  data.setUTCDate(data.getUTCDate() - (data.getUTCDay() + 6) % 7)
  return { dal: data.toISOString().slice(0, 10), al: oggi }
}
