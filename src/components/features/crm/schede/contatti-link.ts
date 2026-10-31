import { normalizzaTelefono } from '@/lib/crm/contatti'

/**
 * CRM della segreteria · i collegamenti di un recapito: chiamare e scrivere su WhatsApp.
 *
 * Senza React: si provano con un `expect`, e la scheda e l'elenco li usano senza ripeterli.
 *
 * ── Quale numero ───────────────────────────────────────────────────────────────────────────────
 * La scheda conserva il numero COME LO HA DIGITATO la segreteria («333 000 0001», «+39 333…»,
 * «081 123 4567»): ricomporlo a mano ogni volta è il modo in cui un link finisce a un altro paese.
 * `normalizzaTelefono` (le ultime 10 cifre, senza il prefisso) dice se è un numero e quale; il
 * prefisso si decide qui:
 *  · il numero ITALIANO digitato senza prefisso («333 000 0001», «081 …», «39 333 …») riceve `39`;
 *  · il numero che dichiara già il proprio paese — comincia con `+` o con `00` — resta com'è: un
 *    «+44 7700 900123» con un `39` davanti scriverebbe a un telefono italiano che non c'è.
 *
 * Un testo che non è un numero (troppo corto, lettere) non dà nessun link: meglio un testo non
 * cliccabile che un collegamento che chiama l'ignoto.
 */

/** Le sole cifre del numero, e dichiara il proprio paese se comincia con `+` o `00`. */
function leggi(raw: string | null | undefined): { cifre: string; internazionale: boolean } | null {
  if (typeof raw !== 'string' || normalizzaTelefono(raw) === null) return null
  const pulito = raw.trim()
  const cifre = pulito.replace(/\D/g, '')
  const internazionale = pulito.startsWith('+') || cifre.startsWith('00')
  return { cifre: cifre.startsWith('00') ? cifre.slice(2) : cifre, internazionale }
}

/** `tel:` con le sole cifre (e il `+` iniziale, se c'era). `null` se non è un numero. */
export function linkTelefono(raw: string | null | undefined): string | null {
  const n = leggi(raw)
  if (n === null) return null
  return `tel:${n.internazionale ? '+' : ''}${n.cifre}`
}

/** `https://wa.me/<paese+numero>`. `null` se non è un numero. */
export function linkWhatsApp(raw: string | null | undefined): string | null {
  const n = leggi(raw)
  if (n === null) return null
  if (n.internazionale) return `https://wa.me/${n.cifre}`
  // Italiano senza prefisso: il numero normalizzato (10 cifre) con il 39 davanti.
  return `https://wa.me/39${normalizzaTelefono(raw) as string}`
}
