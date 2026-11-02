import { dataCivile } from '@/i18n/config'
import { oraCivile } from '@/lib/format/confini-giorno'

/**
 * VOTAZIONI · LA SCADENZA CHE VIAGGIA VERSO IL SERVER.
 *
 * `DateTimeField` parla ISO (un istante), ma il server vuole le CIFRE dell'orologio a muro di Roma,
 * `YYYY-MM-DDTHH:MM` (`zDataOraLocale`, vedi `src/lib/votazioni/schemi.ts`): un ISO costruito dal browser
 * porterebbe con sé l'orologio e il fuso del tablet, e la conversione in istante la fa il server, una volta
 * sola. Qui si fa il passo inverso di `istanteDaLocale`, con le stesse due funzioni che il resto dell'app usa
 * per riempire un campo (`dataCivile` e `oraCivile`, entrambe su `Europe/Rome`).
 *
 * `''` per un istante vuoto o illeggibile: chi chiama non manda niente finché la scadenza non è completa.
 */
export function cifreLocali(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const ora = oraCivile(iso)
  if (!ora) return ''
  return `${dataCivile(d)}T${ora}`
}

/** Due istanti ISO sono lo stesso istante? (Si confrontano i millisecondi, non le stringhe: `Z` e `+00:00` coincidono.) */
export function stessoIstante(a: string, b: string): boolean {
  const x = Date.parse(a)
  const y = Date.parse(b)
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y
}
