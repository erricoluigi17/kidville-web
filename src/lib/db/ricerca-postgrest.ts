/**
 * LA RICERCA TESTUALE SU POSTGREST — sanificazione e composizione, in un posto solo.
 *
 * ─── Il difetto che questo modulo chiude ────────────────────────────────────
 * La stessa sanificazione era scritta DUE volte, in due rotte diverse, con lo
 * stesso insieme di caratteri e un ordine diverso:
 *
 *   · `admin/protocolli/route.ts`   →  testo.replace(/[,()%]/g, ' ').trim()
 *   · `documenti-firmati/route.ts`  →  testo.replace(/[%,()]/g, ' ').trim()
 *
 * Non sono due varianti: sono due copie riscritte a memoria. Finché fanno la
 * stessa cosa nessuno se ne accorge; il giorno in cui una delle due viene
 * corretta (un carattere in più, un `trim` in meno) le due ricerche del cockpit
 * cominciano a comportarsi diversamente, e la differenza si vede solo con un
 * termine che contiene proprio quel carattere.
 *
 * `__tests__/lib/filtri-motore.test.ts` §10 verifica che questo helper produca
 * **byte per byte** la stessa stringa di entrambe: adottarlo non cambia il
 * comportamento di nessuna delle due rotte, che è la sola condizione a cui una
 * unificazione si può fare su codice in produzione.
 *
 * ─── Perché i caratteri sono quelli ─────────────────────────────────────────
 * In `.or(...)` di PostgREST la virgola separa le condizioni, le parentesi
 * aprono e chiudono i gruppi, e il `%` è il jolly di `ilike`. Lasciarli passare
 * non è un problema di sicurezza (postgrest-js non concatena SQL: il filtro
 * viaggia nella query string e il valore resta un parametro), ma di SINTASSI e
 * di significato: una virgola dentro il termine spezza la condizione in due
 * pezzi che non si parsano, e un `%` scritto dall'utente allarga la ricerca
 * invece di restringerla.
 *
 * ⚠️ LIMITE NOTO, dichiarato e NON corretto qui. PostgREST accetta anche `*`
 * come jolly di `ilike` (lo traduce in `%`), e nessuna delle due copie esistenti
 * lo toglie: un termine con l'asterisco allarga la ricerca. Toglierlo qui
 * significherebbe far divergere l'helper dalle due rotte che deve sostituire —
 * cioè cambiare in silenzio il comportamento di due schermate di produzione
 * mentre si fa un lavoro di unificazione. Va deciso e cambiato in un passo suo,
 * con il proprio test e nelle due rotte insieme.
 */

/** I caratteri che in `.or()` di PostgREST hanno un significato loro. */
const METACARATTERI_OR = /[,()%]/g;

/**
 * Il termine ripulito, pronto per finire dentro un `ilike`.
 *
 * Ritorna **stringa vuota** quando del termine non resta niente, ed è la parte
 * che il chiamante deve guardare: `nome.ilike.%%` non è «nessun filtro», è un
 * filtro che passa tutto scritto in un modo che sembra una restrizione.
 */
export function termineOr(testo: string): string {
  return testo.replace(METACARATTERI_OR, ' ').trim();
}

/**
 * Le condizioni `<colonna>.ilike.%<termine>%` separate da virgola, come le
 * vuole `.or()` di postgrest-js.
 *
 * Con un termine vuoto o senza colonne ritorna stringa vuota: il chiamante
 * NON deve chiamare `.or('')` — che PostgREST rifiuta — e soprattutto non deve
 * applicare un filtro che non filtra.
 *
 * Uso tipico:
 * ```ts
 * const termine = termineOr(q.data.ricerca ?? '')
 * const condizioni = orIlike(['nome', 'cognome'], termine)
 * if (condizioni) query = query.or(condizioni)
 * ```
 */
export function orIlike(colonne: readonly string[], termine: string): string {
  if (termine === '' || colonne.length === 0) return '';
  return colonne.map((colonna) => `${colonna}.ilike.%${termine}%`).join(',');
}
