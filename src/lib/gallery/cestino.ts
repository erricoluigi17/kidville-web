import { logEvento } from '@/lib/logging/logger'

/**
 * IL CESTINO DELLA GALLERIA — la regola in un posto solo.
 *
 * ─── IL RISCHIO NUMERO UNO È UNA LETTURA DIMENTICATA ─────────────────────────
 *
 * Dal 2026-09-11 `galleria_media_v2` ha tre colonne di cestino (`eliminato_il`,
 * `eliminato_da`, `file_rimosso_il`): «Elimina» non distrugge più, NASCONDE, e
 * distrugge dopo 30 giorni. La policy RLS del genitore porta `eliminato_il IS
 * NULL` come PRIMA condizione, quindi chi legge con la chiave `authenticated` è
 * già coperto. Ma **quasi tutte le letture di questo repo passano dal
 * service-role**, che la RLS non la vede nemmeno: là il filtro deve essere
 * scritto nella query, e basta UNA query senza filtro perché una foto che
 * un'insegnante ha messo nel cestino **riappaia**.
 *
 * Perciò la regola non è un'abitudine: è questo modulo, e il lock
 * `__tests__/architecture/cestino-galleria-ogni-lettura-dichiara.test.ts`
 * pretende che **ogni** `from('galleria_media_v2')` di `src/` nomini una di
 * queste funzioni. Non «filtra sempre»: *dichiara sempre*, perché i tre versi
 * sono tre decisioni diverse e una di esse deve poter vedere il cestino.
 *
 * ─── PERCHÉ NON UN LOCK «FILTRA SEMPRE» ──────────────────────────────────────
 *
 * Perché sarebbe un DIFETTO, non una protezione. Il diritto all'oblio deve
 * togliere la foto **anche dal cestino**: se `obliaFotoAlunno` filtrasse le sole
 * vive, una foto cestinata **sopravviverebbe alla cancellazione chiesta da una
 * famiglia** — la riga resterebbe, il file resterebbe nel bucket, e
 * `spazio_liberato_il` verrebbe scritto comunque, cioè un «fatto» falso accanto
 * al nome di un bambino. Stessa cosa per il preventivo (`cosa-distrugge.ts`): se
 * annunciasse MENO di quanto l'esecuzione distrugge, il numero che la Direzione
 * conferma non sarebbe quello che accade. Il verso sbagliato, lì, è filtrare.
 *
 * Da qui `ancheNelCestino(q, motivo)`: è l'IDENTITÀ — non aggiunge un filtro —
 * ma obbliga a scrivere PERCHÉ. È il pezzo che rende il lock una decisione
 * invece di un automatismo: chi non filtra lo dice, e lo dice per iscritto.
 *
 * ─── IL DEGRADO, CHE VIENE PRIMA DI TUTTO IL RESTO ───────────────────────────
 *
 * Il DB E2E della CI è un **progetto separato e non migrato**: là le tre colonne
 * non ci sono e `.is('eliminato_il', null)` risponde `42703`. Un filtro aggiunto
 * senza via d'uscita non «indebolisce» la galleria in CI: la **spegne**. La via
 * d'uscita è `leggiVive()`, che ritenta senza filtro UNA volta e lo logga a
 * livello `warn` — non `info`, perché in produzione quel ramo non deve scattare
 * mai e se scatta è una colonna scomparsa, cioè un incidente.
 *
 * ⚠️ Il ritentativo ha bisogno di RICOSTRUIRE la query, non di riusarla: i
 * metodi di PostgREST (`is`, `not`, `lt`) ritornano `this`, cioè **mutano** il
 * builder e restituiscono sé stessi. Non esiste una copia «senza filtro» da
 * riprendere dopo un tentativo fallito, ed è per questo che `leggiVive` prende
 * una funzione che costruisce la query da zero e non la query già costruita.
 * (Lo stesso motivo per cui `GET /api/gallery` ha `buildMedia(conScuola)`
 * invece di due `if`.)
 *
 * ─── IL PREZZO DI QUESTA FORMA: ACCECA IL LOCK DI ISOLAMENTO FRA SEDI ─────────
 *
 * Queste funzioni **avvolgono** la query (`soloVive(supabase.from(…)…)`) invece di
 * aggiungersi in coda alla catena, e ha un prezzo che va scritto qui perché non lo
 * paga chi lo causa: **rompe il riconoscitore di
 * `__tests__/architecture/isolamento-sede-coverage.test.ts`**.
 *
 * Il come, misurato e non supposto (2026-09-12, eseguendo `unitaDiQuery` sulla
 * versione di HEAD e su quella dell'albero di `src/app/api/gallery/route.ts`):
 * quel lock attacca a una query le sue **continuazioni** (`if (conScuola) query =
 * query.in('scuola_id', plessi)`) solo se riesce a leggere il nome della variabile
 * a cui la query è assegnata, e lo cerca con `(const|let|var) X = <ricevitore>`
 * *immediatamente* prima di `.from(`. Un wrapper si infila proprio lì:
 *
 *     let query = soloVive(supabase.from('galleria_media_v2').select('*'))
 *                 └── fra `let query =` e `supabase` c'è `soloVive(`
 *
 * — il nome della variabile non si legge più, le continuazioni non si attaccano, e
 * il filtro di sede che arriva per continuazione **diventa invisibile**. Misura:
 * a HEAD la query di `buildMedia` era UNA unità con `conSede=true`; nell'albero,
 * avvolta, sono tre unità con `conSede=false` e `risultati=[]`, e il lock gemello
 * grida `elenco-senza-sede` su `gallery:GET` — la strada principale della
 * galleria.
 *
 * ⚠️ I DUE LOCK SONO IN CONFLITTO STRUTTURALE, e conviene saperlo prima di
 * incontrarlo: questo pretende il marcatore come wrapper **immediatamente a monte**
 * di `.from(`; `unitaDiQuery` pretende `let X =` **immediatamente a monte** del
 * ricevitore. Quando il filtro di sede arriva per continuazione, le due richieste
 * si escludono a vicenda. Le uscite sono due, e nessuna delle due è una voce in
 * `AMMESSE`:
 *
 *  1. **portare `.in('scuola_id', plessi)` DENTRO la catena** di `.from(`, dove il
 *     testo lo vede chiunque: così `conSede` è vero qualunque wrapper ci sia. È la
 *     strada giusta per `gallery:GET`, ed è anche la più onesta — un isolamento fra
 *     sedi scritto nella query è più difficile da perdere di uno scritto in un `if`
 *     trenta righe più sotto;
 *  2. insegnare a `unitaDiQuery` ad attraversare una chiamata-wrapper quando cerca
 *     la variabile. È una modifica a un lock di un'altra area e va argomentata là.
 *
 * ⚠️ Ma la cecità è FAIL-CLOSED, e questo è l'unico motivo per cui la forma resta:
 * perdere la variabile fa perdere le continuazioni (`conSede` può solo passare da
 * vero a falso), i `risultati` (`suRigaVerificata` diventa falso) e gli usi
 * successivi (`.maybeSingle()` in coda, quindi `singola` diventa falso). Tutte e
 * tre le perdite spingono verso **più** rilievi, non meno: un avvolgimento non può
 * spegnere un rilievo di isolamento che c'era. Misurato sui sei file di lettura di
 * questo modulo: `scoperte()` ne conta esattamente le stesse a HEAD e nell'albero
 * (tasks 1→1, segnalazioni 0→0, educator-sections 1→1, esegui 22→22,
 * cosa-distrugge 2→2, libera-spazio 3→3; e di quei file `isolamento-sede-coverage`
 * scandisce solo i `route.ts`). Su `gallery/route.ts` invece si passa da 3 a 9, e
 * **tre** delle sei nuove (righe 444/448/449) sono esattamente questo effetto.
 */

/**
 * I giorni di grazia. **In codice** stanno qui e in nessun altro posto: la purga e
 * l'elenco del cestino leggono questa costante, e due copie dello stesso 30
 * divergono il giorno in cui qualcuno lo cambia in una.
 *
 * ⚠️ MA IL NUMERO CHE L'UTENTE LEGGE NON VIENE DA QUI, e dirlo importa più che
 * tacerlo. Il dialogo di eliminazione lo prende da `galleryEliminaRipristino`
 * (`messages/it/shared.json`, e l'inglese accanto), dove il 30 è scritto a mano —
 * due volte nella stessa frase. Un file di messaggi non può importare una
 * costante, quindi la duplicazione non si può togliere: si può solo **rendere
 * rumorosa**. Lo fa il lock `cestino-galleria-ogni-lettura-dichiara`, che legge le
 * due chiavi e pretende che contengano questo numero, così il giorno in cui
 * qualcuno porta la costante a 15 e lascia «30 giorni» sullo schermo il gate
 * diventa rosso invece di tacere.
 *
 * La versione precedente di questo commento sosteneva che il testo dell'utente
 * venisse da qui. Non era vero, ed era il danno peggiore: faceva credere che un
 * presidio esistesse, cioè esattamente ciò che un commento non deve mai fare.
 */
export const GIORNI_CESTINO_GALLERIA = 30

/**
 * La soglia della purga: l'istante prima del quale una riga nel cestino ha
 * esaurito i suoi 30 giorni. `adesso` è iniettabile perché un test che congela
 * l'orologio è l'unico modo di provare un confine temporale senza aspettare un
 * mese — e perché una soglia calcolata due volte in due punti è una soglia che
 * un giorno differirà di qualche millisecondo proprio sul confine.
 */
export function sogliaScadenzaCestino(adesso: Date = new Date()): string {
    return new Date(adesso.getTime() - GIORNI_CESTINO_GALLERIA * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * La forma minima di un builder PostgREST filtrabile.
 *
 * Non si importa `PostgrestFilterBuilder`: quel tipo ha cinque parametri
 * generici che cambiano fra le versioni del client, e legarsi ad essi
 * significherebbe riscrivere questo file a ogni `npm update`. Qui servono tre
 * metodi, e i tre ritornano `this` — quindi `Q` si conserva lungo la catena e le
 * sei chiamate restano tipizzate come prima.
 */
interface Filtrabile<Q> {
    is(colonna: string, valore: boolean | null): Q
    not(colonna: string, operatore: string, valore: unknown): Q
    lt(colonna: string, valore: unknown): Q
}

/**
 * SOLO LE FOTO VIVE — il verso di quasi tutte le letture.
 *
 * `eliminato_il IS NULL`. È la stessa condizione che la policy RLS del genitore
 * porta come prima clausola: qui la si scrive perché il service-role quella
 * policy non la incontra.
 */
export function soloVive<Q extends Filtrabile<Q>>(q: Q): Q {
    return q.is('eliminato_il', null)
}

/**
 * SOLO LE FOTO NEL CESTINO, e **soltanto quelle ancora ripristinabili**.
 *
 * Due condizioni, non una:
 *  · `eliminato_il IS NOT NULL` — è nel cestino;
 *  · `file_rimosso_il IS NULL` — il suo file è ancora nello Storage. Una riga il
 *    cui file è già uscito non è più ripristinabile: mostrarla vorrebbe dire
 *    offrire un «Ripristina» che restituisce una foto rotta. Le due colonne non
 *    sono un doppione — fra i due istanti passano 30 giorni, ed è in quello
 *    scarto che vive l'idempotenza della purga.
 *
 * `prima` è il taglio temporale della purga («cosa è nel cestino da più di 30
 * giorni»): `eliminato_il < prima`. Omesso, l'elenco è tutto il cestino.
 */
export function soloNelCestino<Q extends Filtrabile<Q>>(q: Q, prima?: Date | string): Q {
    const base = q.not('eliminato_il', 'is', null).is('file_rimosso_il', null)
    if (prima === undefined) return base
    return base.lt('eliminato_il', prima instanceof Date ? prima.toISOString() : prima)
}

/**
 * ANCHE LE FOTO NEL CESTINO — l'identità, con l'obbligo di scrivere perché.
 *
 * Non aggiunge niente alla query: ritorna `q` com'è. Serve a una cosa sola, e
 * non è cosmetica — **rendere visibile una decisione**. Le letture che devono
 * vedere tutto sono poche e sono tutte gravi (l'oblio GDPR, il preventivo che la
 * Direzione conferma, le scritture per `id` su una riga già letta): senza questa
 * funzione sarebbero indistinguibili da una lettura a cui il filtro è stato
 * dimenticato, e il lock non potrebbe più dire la differenza.
 *
 * `motivo` non viene loggato e non viene controllato a runtime: una funzione
 * chiamata su un percorso di cancellazione non deve poter lanciare né rallentare
 * niente. La lunghezza della ragione la pretende il lock, che la legge nel
 * sorgente — dove serve a chi la prossima volta passerà da lì.
 */
export function ancheNelCestino<Q>(q: Q, motivo: string): Q {
    void motivo
    return q
}

/**
 * Le colonne del cestino non ci sono su questo database.
 *
 *   `42703`   → colonna inesistente in SELECT
 *   `PGRST204`→ colonna non trovata in INSERT/UPDATE
 *
 * Gli stessi due codici di `colonnaSedeAssente` (`src/lib/forms/degrado-sede.ts`),
 * e per la stessa ragione: sono i due modi in cui PostgREST dice «quella colonna
 * non esiste». **Non** ci sono `42P01`/`PGRST205`: quelli dicono che manca la
 * TABELLA, che è un guasto diverso e non si degrada togliendo un filtro.
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

export function colonnaCestinoAssente(error: { code?: string } | null | undefined): boolean {
    return COLONNA_ASSENTE.has(error?.code ?? '')
}

/** Ciò che una lettura PostgREST restituisce sempre, e l'unica parte che serve qui. */
type EsitoLettura = { error: { code?: string } | null }

/**
 * Il filtro che `leggiVive` consegna al costruttore della query: `soloVive` al
 * primo tentativo, l'identità al ritentativo dopo `42703`.
 */
export type FiltroVive = <Q extends Filtrabile<Q>>(q: Q) => Q

const SENZA_FILTRO: FiltroVive = (q) => q

/**
 * LEGGE LE SOLE FOTO VIVE, sopravvivendo a un database che non ha le colonne.
 *
 * `costruisci` riceve il filtro e lo applica DOVE la catena lo consente, poi
 * prosegue liberamente (`.order()`, `.range()`, `.maybeSingle()`, `.single()`).
 * Non è un vezzo di stile: dopo `.maybeSingle()` il builder non ha più `is()`, e
 * un filtro applicato «dall'esterno» non potrebbe più entrare nella query.
 *
 * Al primo `42703`/`PGRST204` la query si RICOSTRUISCE da zero e si esegue con
 * l'identità al posto del filtro — una volta sola, e dicendolo.
 *
 * ⚠️ PERCHÉ UNA FUNZIONE E NON UNA QUERY GIÀ PRONTA: `q.is(…)` ritorna `this`,
 * cioè **muta** il builder. Dopo il primo tentativo non esiste più una versione
 * «pulita» della query da riusare: il filtro è già dentro l'URL. Ricostruire è
 * l'unico modo corretto, ed è lo stesso motivo per cui `GET /api/gallery` ha un
 * `buildMedia(conScuola)` invece di due `if`.
 *
 * ⚠️ PERCHÉ `warn` E NON `info`: in produzione le tre colonne esistono
 * (verificato su `information_schema.columns` il 2026-09-12), quindi questo ramo
 * non deve scattare mai. Se scatta, una colonna è scomparsa e la galleria sta
 * mostrando a tutti righe cestinate: `info` lo seppellirebbe nel traffico, e
 * quella riga è l'unica cosa che distingue «tutto bene» da «il cestino non
 * funziona più». Un degrado che non si vede è un fail-open.
 *
 * ⚠️ E NON SI RITENTA DUE VOLTE. Se anche la seconda lettura fallisce, il suo
 * `{ error }` torna al chiamante intatto: qui non si inghiotte niente. PostgREST
 * non lancia, e chi chiama controlla il valore di ritorno — come sempre.
 */
export async function leggiVive<T extends EsitoLettura>(
    costruisci: (vive: FiltroVive) => PromiseLike<T>,
    operazione: string,
): Promise<T> {
    const primo = await costruisci(soloVive)
    if (!colonnaCestinoAssente(primo.error)) return primo
    logEvento('galleria', 'warn', {
        operazione,
        esito: 'degrado-cestino-colonna-assente',
        error_code: primo.error?.code,
    })
    return await costruisci(SENZA_FILTRO)
}
