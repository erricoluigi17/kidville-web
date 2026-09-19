import { riepilogoPosti, type RigaAdesione } from '@/lib/avvisi/posti';

/**
 * ─── TUTTI I NUMERI DELLA SCHERMATA DELLE ADESIONI, IN UNA FUNZIONE SOLA ─────
 *
 * 🔴 PERCHÉ ESISTE. Fino al 2026-09-19 i numeri di questa schermata vivevano in
 * due posti e contavano su DUE BASI diverse, e nessuno dei due era sbagliato da
 * solo:
 *
 *   · i tre contatori Sì / No / Senza risposta — `Math.max(0, totalTarget −
 *     (siCount + noCount))`, con `totalTarget` preso dagli alunni INCROCIATI e
 *     `siCount`/`noCount` da TUTTE le righe del server;
 *   · il riquadro dei posti — tutte le righe del server.
 *
 * Basta una riga di risposta per un bambino uscito dalle sezioni destinatarie
 * perché la sottrazione attraversi le due basi e dia «Senza risposta 0» **mentre
 * quel bambino è a schermo e il filtro lo restituisce**. Ed era peggio: il
 * `Math.max(0, …)` ingoiava il negativo in silenzio — la stessa forma del `?? 0`
 * che in questo repo ha congelato per sempre lo stato SDI di una fattura.
 *
 * Perciò i numeri stanno qui, insieme, e ciascuno dichiara la propria base.
 *
 * ── LE DUE BASI RESTANO DUE, MA SONO SCRITTE ────────────────────────────────
 *
 * Non si può averne una sola, e fingerlo sarebbe il difetto di prima al contrario:
 *
 *   · i tre CONTATORI contano l'ELENCO — una riga per alunno destinatario, che è
 *     ciò che la segreteria vede e può ricontare a mano;
 *   · i POSTI contano TUTTE le righe del server, perché è la base di
 *     `avviso_posti_occupati`: contare le sole incrociate darebbe un totale più
 *     BASSO, e più basso è il verso pericoloso — farebbe credere che il pullman
 *     abbia posto.
 *
 * Lo SCARTO fra le due (`nonIncrociate`) esce da qui come un numero, e la
 * schermata lo dice. Un totale che non si può sommare a mano dai nomi accanto è
 * un totale che la segreteria non ha modo di verificare: 12 dichiarate e 7
 * sommabili sono cinque persone invisibili, e una schermata che non le nomina le
 * fa sembrare un errore di qualcun altro.
 *
 * ── `misurato`: «NON LO SO» NON È «ZERO» ────────────────────────────────────
 *
 * Su un database non migrato (il DB E2E della CI, e il ripiego dichiarato dalla
 * rotta) le due colonne del cantiere non esistono e la rotta le OMETTE: le righe
 * arrivano senza `stato_adesione`. Zero righe ammesse è allora una conseguenza
 * dell'assenza del campo, non una misura — e «0 persone · 0 in lista d'attesa» è
 * l'unica frase capace di far sembrare vuoto un pullman pieno. `misurato` porta
 * quella differenza fino allo schermo, che senza di lei non ha modo di dirla.
 */

/** Una riga di risposta come la manda `GET /api/avvisi/[id]/risposte`. */
export interface RigaRisposta {
    parent_id?: string | null;
    /** `'si' | 'no' | null` — `null` è «ha solo letto». */
    risposta?: string | null;
    /** **Assente** (non `null`) su un database non migrato: vedi `misurato`. */
    numero_partecipanti?: number | null;
    /** **Assente** (non `null`) su un database non migrato: vedi `misurato`. */
    stato_adesione?: string | null;
}

/** Una riga dell'elenco a schermo: un alunno destinatario, con o senza risposta. */
export interface RigaIncrociata {
    /** `null` quando quella famiglia non ha MAI risposto: nessuna riga di risposta. */
    rispostaId: string | null;
    /** `'si' | 'no' | 'attesa'` — `attesa` qui significa **senza risposta**. */
    risposta: string;
}

export interface NumeriAdesioni {
    /** Gli alunni dell'ELENCO che hanno detto sì. */
    si: number;
    /** Gli alunni dell'ELENCO che hanno detto no. */
    no: number;
    /** Gli alunni dell'ELENCO che non hanno ancora risposto. NON è la lista d'attesa. */
    senzaRisposta: number;
    /** Le PERSONE ammesse, su tutte le righe del server. */
    persone: number;
    /** Le famiglie DISTINTE ammesse. */
    famiglie: number;
    /** Quante righe sono in coda. */
    inAttesa: number;
    /** Quante persone valgono quelle righe in coda. */
    personeInAttesa: number;
    /** Il tetto è già superato? È uno stato legittimo, non un errore. */
    sopraCapienza: boolean;
    /** Almeno una riga porta davvero `stato_adesione`: i posti si sono potuti contare. */
    misurato: boolean;
    /**
     * Le righe del server che l'elenco NON MOSTRA con un proprio chip a schermo.
     *
     * 🔴 IL NOME (e la frase `postiNonIncrociate` che lo mostra) SONO IMPRECISI PER
     * UN CASO REALE: genitori separati. L'unicità è su `(avviso_id, parent_id,
     * student_id)`, quindi due righe per lo STESSO alunno — una per genitore — sono
     * legittime e già in produzione. `elenco` porta una riga per alunno destinatario
     * e sceglie con `.find()` la PRIMA risposta che trova; la seconda riga di quello
     * stesso alunno finisce comunque qui dentro, insieme alle righe davvero fuori
     * sezione — e la frase attuale dice «non associata a un alunno di queste
     * sezioni», che per la seconda riga di un genitore separato è FALSA: quel
     * bambino è a schermo.
     *
     * Il NUMERO resta giusto così com'è (e non va scomposto qui dentro): `persone`/
     * `famiglie` (da `riepilogoPosti`, `@/lib/avvisi/posti`) sommano TUTTE le righe
     * del server, quindi anche la riga del secondo genitore pesa sul totale senza
     * avere un chip proprio — è «invisibile» esattamente come una riga fuori
     * sezione, e va dichiarata allo stesso modo (vedi la testata di
     * `RiepilogoPosti.tsx`: un totale più alto e inspiegato è il difetto peggiore).
     *
     * La frase, invece, andrebbe riformulata perché regga entrambi i casi — o i due
     * casi andrebbero distinti con due frasi diverse. **Non l'ho fatto**: in
     * entrambe le strade la stringa italiana (nuova o riscritta) vive in
     * `messages/it/avvisi.json` (+ `en`), che è fuori dal perimetro di questo
     * intervento («un altro cantiere sta scrivendo il PRD e un altro le rotte» —
     * qui vale anche per i cataloghi). Chi possiede quei file: la frase da rivedere
     * è la chiave `postiNonIncrociate`.
     */
    nonIncrociate: number;
}

export function numeriAdesioni(
    elenco: readonly RigaIncrociata[],
    righeServer: readonly RigaRisposta[],
    postiTotali: number | null,
): NumeriAdesioni {
    const perPosti: RigaAdesione[] = righeServer.map((r) => ({
        numero_partecipanti: r.numero_partecipanti ?? null,
        stato_adesione: r.stato_adesione ?? null,
        parent_id: r.parent_id ?? null,
    }));
    const posti = riepilogoPosti(perPosti, postiTotali);

    let si = 0;
    let no = 0;
    let senzaRisposta = 0;
    let incrociate = 0;
    for (const riga of elenco) {
        if (riga.rispostaId !== null) incrociate += 1;
        if (riga.risposta === 'si') si += 1;
        else if (riga.risposta === 'no') no += 1;
        else senzaRisposta += 1;
    }

    return {
        ...posti,
        si,
        no,
        senzaRisposta,
        // `!== undefined` e non un `??`: `null` è una misura («questa famiglia non
        // aderisce»), l'assenza del campo non lo è. Distinguerle è tutto il punto.
        //
        // ⚠️ CON `righeServer` VUOTO QUESTO È SEMPRE `false`, ED È UN FALSO NEGATIVO
        // VOLUTO. A rigore, zero risposte su un database migrato sarebbe una misura
        // vera e propria — «0 persone su N posti» — e non un «non lo so». Ma da un
        // array vuoto le due situazioni (zero adesioni vere, oppure database non
        // migrato che le ha semplicemente omesse) sono indistinguibili: non c'è
        // nessuna riga su cui controllare se `stato_adesione` esiste come chiave.
        // Il costo di sbagliare non è simmetrico: dire «non misurato» dove in realtà
        // era zero fa GUARDARE la schermata un momento in più senza alcun danno; dire
        // «0» dove in realtà non si è potuto contare fa NON guardare — ed è
        // esattamente il pullman pieno che sembra vuoto, il difetto che questo file
        // esiste per chiudere. Fra un falso negativo innocuo e un falso positivo
        // pericoloso, qui si sceglie sempre il primo.
        misurato: righeServer.some((r) => r.stato_adesione !== undefined),
        // Nessun `Math.max(0, …)`: per costruzione ogni riga incrociata viene da una
        // riga del server e nessuna è incrociata due volte, quindi la differenza non
        // può essere negativa. Se un giorno lo diventasse, deve VEDERSI — una
        // sottrazione che si appiattisce a zero è il difetto che questo file chiude.
        //
        // ⚠️ LA PREMESSA STA IN UN ALTRO FILE. «Nessuna è incrociata due volte» regge
        // solo perché `elenco` (= `targetStudents.map(...)` in `AvvisoDetailsContent`)
        // non porta id ripetuti: lì c'è un `filter`/`findIndex` che deduplica gli
        // studenti per `id` PRIMA di costruire l'elenco. Se quella deduplicazione
        // sparisse (o smettesse di essere per `id`), uno stesso alunno destinatario
        // comparirebbe due volte in `elenco`, la stessa riga di risposta verrebbe
        // contata due volte come «incrociata», e questa differenza potrebbe diventare
        // negativa — che è l'esito CORRETTO in quel caso: si vede, invece di sparire.
        nonIncrociate: righeServer.length - incrociate,
    };
}
