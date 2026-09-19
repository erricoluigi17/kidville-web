import { formatData } from '@/lib/i18n/date';

/**
 * ─── COME SI LEGGE LA SCADENZA DI UN AVVISO, IN UN POSTO SOLO ───────────────
 *
 * ⚠️ La colonna STORICA `scadenza` è una `date` pura (`2026-11-05`), e
 * `new Date('2026-11-05')` è mezzanotte **UTC** — cioè le 02:00 italiane
 * d'estate. Stamparla come «data e ora» le appiccicherebbe addosso un «02:00»
 * che nessuno ha mai scritto. Le scadenze nuove sono istanti veri e portano
 * l'ora, che lì serve: un termine «entro le 12:00» è un'informazione, non un
 * dettaglio.
 *
 * ── PERCHÉ NON È PIÙ UNA FUNZIONE PRIVATA DELLA BACHECA ─────────────────────
 *
 * Perché era privata, e la pagina di dettaglio accanto formattava la stessa
 * colonna con `formattaIstante(new Date(…), locale)`: nessun errore di data (le
 * opzioni vuote rendono la sola data, quindi nessun «02:00» inventato), ma due
 * letture diverse dello stesso valore a due file di distanza — la bacheca
 * mostrava l'ora di un termine «entro le 12:00», il dettaglio la perdeva. È la
 * stessa forma che su questi avvisi ha già prodotto due divergenze vere, ed è la
 * ragione per cui `@/lib/avvisi/scadenze` esiste: una regola che vive in più di
 * un posto non si rompe, **diverge**.
 *
 * Questo è il MOSTRARE, non il confrontare: il confronto ha il suo arbitro
 * (`avvisoScaduto`, `adesioniChiuse`) e un lock che lo difende. Il posto naturale
 * di questa funzione è accanto a quelli, in `@/lib/avvisi/scadenze`; finché non
 * ci si sposta, vive qui e la importano entrambe le pagine del cockpit — l'unica
 * cosa che non deve poter tornare è averne due copie.
 */
export function scadenzaLeggibile(iso: string | null | undefined, locale: string): string {
    if (!iso) return '';
    return formatData(iso, locale, iso.includes('T') ? 'dataOra' : 'breve');
}
