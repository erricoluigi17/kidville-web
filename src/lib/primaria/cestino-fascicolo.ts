/**
 * IL CESTINO DEL FASCICOLO — ogni lettura di `student_documents` dice cosa fa del cestino.
 *
 * Dal 2026-09-24 (spec «sei interventi», compito F1) un documento del fascicolo
 * eliminato, o SOSTITUITO da un file nuovo, non sparisce: resta nella tabella con
 * `eliminato_il` valorizzato, si può ripristinare per `GIORNI_CESTINO_REGISTRO`
 * giorni (`./cestino-registro.ts`), poi la purga toglie riga e file.
 *
 * Il rischio numero uno è una lettura dimenticata. Quasi tutto il repo legge
 * `student_documents` col **service-role**, che la RLS non la incontra: il filtro
 * va scritto nella query, e basta UNA query senza filtro perché un documento
 * eliminato — una diagnosi, un PEI, un verbale della 104 — **riappaia**: nel
 * fascicolo, nell'archivio dei documenti firmati, nel promemoria delle scadenze,
 * o come «autorizzazione all'uscita» di una gita che nessuno ha più firmato.
 *
 * Per questo la regola non è un'abitudine ma questo modulo, e il lock
 * `__tests__/architecture/cestino-fascicolo-ogni-lettura-dichiara.test.ts`
 * pretende che ogni `from('student_documents')` di `src/` (tranne gli INSERT, che
 * fanno nascere una riga viva) nomini una di queste tre funzioni:
 *
 *   · `fascicoloVivo(q)`                — i soli documenti vivi (il verso di quasi tutto);
 *   · `fascicoloNelCestino(q)`          — il cestino: elenco, ripristino, purga;
 *   · `fascicoloAncheNelCestino(q, m)`  — l'IDENTITÀ, con l'obbligo di scrivere perché.
 *                                         È per l'oblio GDPR e per il suo preventivo:
 *                                         lì filtrare le sole vive lascerebbe un
 *                                         documento nel cestino a sopravvivere alla
 *                                         cancellazione chiesta da una famiglia.
 *
 * Stesso disegno del cestino della galleria (`@/lib/gallery/cestino`), con nomi
 * DIVERSI di proposito: un marcatore è un contratto sulla tabella, e un
 * `soloVive` della galleria applicato a `student_documents` direbbe «filtrato»
 * al lock sbagliato.
 *
 * ─── MODULO PURO ─────────────────────────────────────────────────────────────
 * Nessun import: lo possono leggere route, lib e (se servisse) il client.
 *
 * ⚠️ Il DB E2E della CI prende la colonna `eliminato_il` solo con «DB migrate (CI)»
 * sulla migrazione `20260924220000_primaria_modifica_elimina.sql`. Qui NON c'è un
 * ripiego «senza filtro» come `leggiVive` della galleria: su un documento sanitario
 * mostrare anche quelli eliminati è il verso sbagliato di un degrado.
 */

/** Il sottoinsieme di un builder PostgREST che serve qui. */
interface Filtrabile<Q> {
  is(colonna: string, valore: boolean | null): Q
  not(colonna: string, operatore: string, valore: unknown): Q
}

/** I soli documenti VIVI: `eliminato_il IS NULL`. */
export function fascicoloVivo<Q extends Filtrabile<Q>>(q: Q): Q {
  return q.is('eliminato_il', null)
}

/**
 * I soli documenti NEL CESTINO: `eliminato_il IS NOT NULL`.
 *
 * Non filtra per scadenza: chi elenca ciò che si può ancora ripristinare aggiunge
 * `.gte('eliminato_il', sogliaPurgaCestinoRegistro())`, la purga `.lt(…)`.
 */
export function fascicoloNelCestino<Q extends Filtrabile<Q>>(q: Q): Q {
  return q.not('eliminato_il', 'is', null)
}

/**
 * L'IDENTITÀ: non filtra. Esiste per obbligare chi legge anche il cestino a
 * scrivere PERCHÉ — il lock pretende un `motivo` di almeno sessanta caratteri.
 */
export function fascicoloAncheNelCestino<Q>(q: Q, motivo: string): Q {
  void motivo
  return q
}
