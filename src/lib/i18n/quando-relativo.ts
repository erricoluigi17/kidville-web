import { dataCivile, formattaIstante } from '@/i18n/config'

export type GiornoRelativo = 'oggi' | 'domani' | 'altro'

/**
 * `type` e non `interface`, di proposito: il valore si passa intero a un formattatore ICU,
 * che vuole un `Record<string, …>`, e un'interface non ha la firma d'indice implicita (TS2345).
 */
export type QuandoRelativo = {
  giorno: GiornoRelativo
  /** `HH:MM` in Europe/Rome, nella lingua data. */
  ora: string
  /** Giorno breve + `gg/mm` in Europe/Rome: «ven 25/09», «Fri 25/09». */
  data: string
}

/**
 * Giorni di calendario da `da` ad `a`, due date civili `YYYY-MM-DD` (`dataCivile`). In UTC di
 * proposito: lì un giorno dura sempre 86.400.000 ms, anche nelle due notti in cui a Roma ne dura
 * 23 o 25. Stessa scelta di `giornoCivilePiu` (`src/lib/avvisi/promemoria-adesioni.ts`).
 */
function giorniFra(da: string, a: string): number {
  const [y1, m1, g1] = da.split('-').map(Number)
  const [y2, m2, g2] = a.split('-').map(Number)
  return (Date.UTC(y2, m2 - 1, g2) - Date.UTC(y1, m1 - 1, g1)) / 86_400_000
}

/**
 * Un istante detto come lo legge la segreteria: «alle 14:30», «domani alle 00:03»,
 * «ven 25/09 alle 08:00» (consegna 2a della coda fatture, rilievo c).
 *
 * Giorno e ora SEMPRE in Europe/Rome, qualunque sia il fuso del processo o del browser.
 * «Oggi» e «domani» si decidono sulle DATE CIVILI (`dataCivile` + `giorniFra`), mai sui
 * millisecondi: il 25/10 dura 25 ore e il 29/03 ne dura 23. Istante illeggibile → `null`.
 */
export function quandoRelativo(
  istante: string | number | Date | null | undefined,
  adesso: Date | number,
  locale: string,
): QuandoRelativo | null {
  if (istante === null || istante === undefined || istante === '') return null
  const d = istante instanceof Date ? istante : new Date(istante)
  const a = adesso instanceof Date ? adesso : new Date(adesso)
  // `dataCivile` chiama `Intl…format`, che su una Date invalida LANCIA: il controllo va prima.
  if (Number.isNaN(d.getTime()) || Number.isNaN(a.getTime())) return null
  const scarto = giorniFra(dataCivile(a), dataCivile(d))
  return {
    giorno: scarto === 0 ? 'oggi' : scarto === 1 ? 'domani' : 'altro',
    ora: formattaIstante(d, locale, { hour: '2-digit', minute: '2-digit' }),
    data: formattaIstante(d, locale, { weekday: 'short', day: '2-digit', month: '2-digit' }),
  }
}
