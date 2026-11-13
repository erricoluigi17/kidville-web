/**
 * CRM ASSISTENTE FAMIGLIE · ORIENTAMENTO PER ETÀ.
 *
 * Indica gli ordini da proporre nell'anno scolastico corrente o nel prossimo.
 * Il nido parte dai 3 mesi di vita, contati oggi o al prossimo 1° settembre (anche per un bambino non
 * ancora nato); i limiti superiori sono quelli per anno di nascita sotto.
 * L'anno effettivo va confermato nella prenotazione. Per orientarsi basta il
 * mese di nascita: il giorno esatto non serve.
 */

import { annoDelGiorno, giornoValido } from '@/lib/anno-scolastico'

export type Grado = 'nido' | 'infanzia' | 'primaria'

const GRADI: readonly Grado[] = ['nido', 'infanzia', 'primaria']
/** Il nido accoglie dai 3 mesi (decisione del titolare, 13/11/2026). */
export const ETA_MINIMA_NIDO_MESI = 3

const FORMA_MESE = /^\d{4}-(0[1-9]|1[0-2])$/

export function gradiPerNascita(nascita: string, oggi: string): Grado[] {
  if (!FORMA_MESE.test(nascita) || !giornoValido(oggi)) return []

  const { annoInizio } = annoDelGiorno(oggi)
  const annoNascita = Number(nascita.slice(0, 4))
  const anticipo = Number(nascita.slice(5)) <= 4
  const gradi = new Set<Grado>()
  // Il nido guarda i mesi di vita al prossimo 1° settembre, inizio dell'anno in cui entrerebbe. Chi ha già
  // 3 mesi oggi li ha anche a settembre, quindi basta questa data; chi non è ancora nato conta come gli altri.
  // I mesi sono di calendario: il giorno esatto non c'è.
  const mese = (y: number, m: number) => y * 12 + m
  const annoOggi = Number(oggi.slice(0, 4))
  const meseOggi = Number(oggi.slice(5, 7))
  const meseNascita = mese(annoNascita, Number(nascita.slice(5)))
  const prossimoSettembre = mese(meseOggi >= 9 ? annoOggi + 1 : annoOggi, 9)
  const nidoPossibile = prossimoSettembre - meseNascita >= ETA_MINIMA_NIDO_MESI

  for (const anno of [annoInizio, annoInizio + 1]) {
    // Conta gli anni compiuti entro il 31 dicembre di ciascun anno di ingresso.
    const eta = anno - annoNascita
    if (eta >= 0 && eta <= 2 && nidoPossibile) gradi.add('nido')
    if ((eta >= 3 && eta <= 5) || (eta === 2 && anticipo)) gradi.add('infanzia')
    if ((eta >= 6 && eta <= 10) || (eta === 5 && anticipo)) gradi.add('primaria')
  }

  return GRADI.filter((grado) => gradi.has(grado))
}

export function meseDiNascita(dataNascita: string | null | undefined): string | null {
  return dataNascita && giornoValido(dataNascita) ? dataNascita.slice(0, 7) : null
}
