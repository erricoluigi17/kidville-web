/**
 * Le date della settimana mensa, come stringhe `AAAA-MM-GG`.
 *
 * Si calcola in UTC su mezzogiorno, mai su `Date` locali: il calendario del genitore
 * parte da una mezzanotte LOCALE e la stampa con `toISOString()`, che in Italia la
 * riporta al giorno prima. Qui il giorno resta il giorno, qualunque fuso abbia il
 * browser e in qualunque settimana cada il cambio d'ora. Il punto di partenza è
 * `oggiRoma()` di `@/lib/mensa/cutoff`.
 */

function aData(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`)
}

/** `ymd` spostato di `n` giorni (anche negativi). */
export function piuGiorni(ymd: string, n: number): string {
  const d = aData(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Il lunedì della settimana di `ymd` (la domenica appartiene alla settimana che finisce). */
export function lunediDi(ymd: string): string {
  const giorno = aData(ymd).getUTCDay() // 0 = domenica
  return piuGiorni(ymd, giorno === 0 ? -6 : 1 - giorno)
}

/** I sette giorni da `lunedi` a domenica. */
export function giorniDellaSettimana(lunedi: string): string[] {
  return Array.from({ length: 7 }, (_, i) => piuGiorni(lunedi, i))
}
