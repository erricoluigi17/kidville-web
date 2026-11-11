/**
 * CRM ASSISTENTE FAMIGLIE · ORIENTAMENTO PER ETÀ.
 *
 * Indica gli ordini da proporre nell'anno scolastico corrente o nel prossimo.
 * L'anno effettivo va confermato nella prenotazione. Per orientarsi basta il
 * mese di nascita: il giorno esatto non serve.
 */

import { annoDelGiorno, giornoValido } from '@/lib/anno-scolastico'

export type Grado = 'nido' | 'infanzia' | 'primaria'

const GRADI: readonly Grado[] = ['nido', 'infanzia', 'primaria']
const FORMA_MESE = /^\d{4}-(0[1-9]|1[0-2])$/

export function gradiPerNascita(nascita: string, oggi: string): Grado[] {
  if (!FORMA_MESE.test(nascita) || !giornoValido(oggi) || nascita > oggi.slice(0, 7)) return []

  const { annoInizio } = annoDelGiorno(oggi)
  const annoNascita = Number(nascita.slice(0, 4))
  const anticipo = Number(nascita.slice(5)) <= 4
  const gradi = new Set<Grado>()

  for (const anno of [annoInizio, annoInizio + 1]) {
    // Conta gli anni compiuti entro il 31 dicembre di ciascun anno di ingresso.
    const eta = anno - annoNascita
    if (eta >= 0 && eta <= 2) gradi.add('nido')
    if ((eta >= 3 && eta <= 5) || (eta === 2 && anticipo)) gradi.add('infanzia')
    if ((eta >= 6 && eta <= 10) || (eta === 5 && anticipo)) gradi.add('primaria')
  }

  return GRADI.filter((grado) => gradi.has(grado))
}

export function meseDiNascita(dataNascita: string | null | undefined): string | null {
  return dataNascita && giornoValido(dataNascita) ? dataNascita.slice(0, 7) : null
}
