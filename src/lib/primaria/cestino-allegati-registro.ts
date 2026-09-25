/**
 * IL CESTINO DEGLI ALLEGATI DEL REGISTRO — ogni lettura di `allegati_registro` dice
 * cosa fa del cestino.
 *
 * Dal 2026-09-24 (spec «sei interventi», compito R2) un allegato del registro
 * eliminato, SOSTITUITO da un file nuovo, o rimasto senza lezione perché la lezione
 * è stata eliminata, non sparisce: resta nella tabella con `eliminato_il`
 * valorizzato, si può ripristinare per `GIORNI_CESTINO_REGISTRO` giorni
 * (`./cestino-registro.ts`), poi la purga toglie riga e file.
 *
 * Il rischio numero uno è una lettura dimenticata. Tutto il repo legge
 * `allegati_registro` col **service-role**, che la RLS non la incontra: il filtro va
 * scritto nella query, e basta UNA lettura senza filtro perché un allegato eliminato
 * — la foto di una lavagna, una verifica con i nomi dei bambini — **riappaia**: nel
 * registro del docente, nei compiti della classe, nelle lezioni che legge il genitore.
 *
 * Per questo la regola non è un'abitudine ma questo modulo, e il lock
 * `__tests__/architecture/cestino-allegati-registro-ogni-lettura-dichiara.test.ts`
 * pretende che ogni `from('allegati_registro')` di `src/` (tranne gli INSERT, che fanno
 * nascere una riga viva) nomini una di queste tre funzioni:
 *
 *   · `allegatiRegistroVivi(q)`                — i soli allegati vivi (il verso di quasi tutto);
 *   · `allegatiRegistroNelCestino(q)`          — il cestino: elenco, ripristino, purga;
 *   · `allegatiRegistroAncheNelCestino(q, m)`  — l'IDENTITÀ, con l'obbligo di scrivere perché.
 *
 * ─── E GLI ALLEGATI LETTI DENTRO UN'ALTRA QUERY (embed) ──────────────────────
 * Tre route leggono gli allegati come risorsa annidata della lezione
 * (`registro_orario.select('…, allegati_registro(…)')`). Lì il filtro NON si scrive
 * con `.is('allegati_registro.eliminato_il', null)`, e la ragione va detta:
 * PostgREST applicherebbe il filtro alle sole righe annidate (giusto), ma il finto
 * database dei test lo emula come un `!inner` e farebbe sparire le LEZIONI senza
 * allegati — cioè ogni test di quelle route diventerebbe rosso per un motivo che in
 * produzione non esiste, oppure verde per un motivo che non c'entra. Si fa quindi
 * in codice, in un posto solo: l'embed seleziona anche `eliminato_il`, e le righe
 * annidate passano da `allegatiRegistroViviDalJoin` PRIMA di qualunque uso (link
 * firmati compresi). Il lock pretende entrambe le cose.
 *
 * Nomi DIVERSI da quelli del fascicolo (`fascicoloVivo`) e della galleria
 * (`soloVive`) di proposito: un marcatore è un contratto sulla SUA tabella.
 *
 * ─── MODULO PURO ─────────────────────────────────────────────────────────────
 * Nessun import: lo possono leggere route, lib e (se servisse) il client.
 *
 * ⚠️ Il DB E2E della CI prende la colonna `eliminato_il` solo con «DB migrate (CI)»
 * sulla migrazione `20260924220000_primaria_modifica_elimina.sql`. Come per il
 * fascicolo, qui NON c'è un ripiego «senza filtro»: mostrare anche gli allegati
 * eliminati è il verso sbagliato di un degrado.
 */

/** Il sottoinsieme di un builder PostgREST che serve qui. */
interface Filtrabile<Q> {
  is(colonna: string, valore: boolean | null): Q
  not(colonna: string, operatore: string, valore: unknown): Q
}

/** I soli allegati VIVI: `eliminato_il IS NULL`. */
export function allegatiRegistroVivi<Q extends Filtrabile<Q>>(q: Q): Q {
  return q.is('eliminato_il', null)
}

/**
 * I soli allegati NEL CESTINO: `eliminato_il IS NOT NULL`.
 *
 * Non filtra per scadenza: chi elenca ciò che si può ancora ripristinare aggiunge
 * `.gte('eliminato_il', sogliaPurgaCestinoRegistro())`, la purga `.lt(…)`.
 */
export function allegatiRegistroNelCestino<Q extends Filtrabile<Q>>(q: Q): Q {
  return q.not('eliminato_il', 'is', null)
}

/**
 * L'IDENTITÀ: non filtra. Esiste per obbligare chi legge anche il cestino a
 * scrivere PERCHÉ — il lock pretende un `motivo` di almeno sessanta caratteri.
 */
export function allegatiRegistroAncheNelCestino<Q>(q: Q, motivo: string): Q {
  void motivo
  return q
}

/**
 * Gli allegati VIVI fra quelli arrivati annidati in una lezione
 * (`allegati_registro(…, eliminato_il)`). Accetta `null`/`undefined` (lezione senza
 * allegati, o embed non letto) e restituisce sempre un array.
 *
 * `eliminato_il` ASSENTE vale «vivo», ed è una scelta: la chiave manca solo se la
 * select non l'ha chiesta, e quel caso lo prende il lock (l'embed deve nominare
 * `eliminato_il`), non questa funzione. Scartare le righe senza la chiave farebbe
 * sparire in silenzio tutti gli allegati il giorno che qualcuno la togliesse dalla
 * select — un guasto opposto, ma sempre muto.
 */
export function allegatiRegistroViviDalJoin<T extends { eliminato_il?: string | null }>(
  righe: readonly T[] | null | undefined,
): T[] {
  return (righe ?? []).filter((a) => a != null && a.eliminato_il == null)
}
