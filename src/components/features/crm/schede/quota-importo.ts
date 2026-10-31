/**
 * CRM della segreteria · l'IMPORTO DELLA QUOTA, scritto e letto all'italiana.
 *
 * Funzioni pure, fuori dai componenti: le usano il modulo della quota (`QuotaIscrizione`) e le etichette dello
 * storico (`DettaglioScheda`), e un componente sostituito da un marcatore nei test non deve portarsele via.
 *
 *  · si SCRIVE con la virgola (`150,50`) o con il punto (`150.5`): `Number(valore.replace(',', '.'))`. Due
 *    decimali al massimo, maggiore di zero, non oltre il tetto della route. Le migliaia (`1.500,00`) non si
 *    accettano: «1.500» è mille e cinquecento o uno virgola cinque? La route rifiuta con 400 il resto;
 *  · si LEGGE sempre con due decimali e la virgola, con il locale esplicito (`it-IT`), senza il simbolo: lo
 *    mette la frase del catalogo («{importo} €»).
 */

/** Il tetto della route (`putBodySchema` di `…/quota`): oltre, la route risponde 400. */
export const IMPORTO_MASSIMO = 100000

const FORMATO_IMPORTO = /^\d+(?:[.,]\d{1,2})?$/

const EURO = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** «150,50» o «150.5» → 150.5; tutto il resto (tre decimali, zero, negativi, migliaia, lettere) → `null`. */
export function importoDaTesto(testo: string): number | null {
  const pulito = testo.trim()
  if (!FORMATO_IMPORTO.test(pulito)) return null
  const n = Number(pulito.replace(',', '.'))
  return Number.isFinite(n) && n > 0 && n <= IMPORTO_MASSIMO ? n : null
}

/** `numeric` arriva da PostgREST come numero o come stringa. */
function comeNumero(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** «150,50» (senza il simbolo: lo mette la frase del catalogo). `null` se non è un numero. */
export function importoLeggibile(v: number | string | null | undefined): string | null {
  const n = comeNumero(v)
  return n === null ? null : EURO.format(n)
}

/** L'importo com'è nel campo del modulo quando si corregge: la virgola, due decimali. Vuoto se non c'è. */
export function importoPerCampo(v: number | string | null | undefined): string {
  const n = comeNumero(v)
  return n === null ? '' : n.toFixed(2).replace('.', ',')
}
