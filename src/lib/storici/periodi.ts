export type PeriodoStorico = 'giorno' | 'settimana' | 'mese' | 'anno' | 'tutto'
export function periodoStorico(tipo: PeriodoStorico, oggi: string): { dal: string; al: string } {
  const [anno, mese, giorno] = oggi.split('-').map(Number)
  if (tipo === 'tutto') return { dal: '1900-01-01', al: oggi }
  if (tipo === 'giorno') return { dal: oggi, al: oggi }
  if (tipo === 'mese') return { dal: `${oggi.slice(0, 7)}-01`, al: oggi }
  if (tipo === 'anno') return { dal: `${mese >= 9 ? anno : anno - 1}-09-01`, al: oggi }
  const data = new Date(Date.UTC(anno, mese - 1, giorno))
  data.setUTCDate(data.getUTCDate() - (data.getUTCDay() + 6) % 7)
  return { dal: data.toISOString().slice(0, 10), al: oggi }
}
