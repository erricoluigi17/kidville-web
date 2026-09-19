import { fineGiornoCivile, istanteDaLocale } from '@/lib/format/confini-giorno';

/**
 * ─── LE DUE SCADENZE DI UN AVVISO, IN UN POSTO SOLO ──────────────────────────
 *
 * Un avviso ha due momenti, e fino al 2026-09-19 ne aveva uno solo chiamato
 * `scadenza`:
 *
 *   · `scadenza_avviso`   — quando sparisce dalla bacheca dei genitori.
 *                           Obbligatoria su OGNI avviso.
 *   · `scadenza_adesione` — l'ultimo istante per aderire. Obbligatoria sugli
 *                           avvisi `tipo = 'adesione'`, e mai dopo l'altra.
 *
 * Averne due distinte serve al caso che la segreteria chiede da sempre: «le
 * adesioni si chiudono venerdì, ma l'avviso deve restare leggibile fino alla
 * gita». Con un campo solo quel caso si otteneva togliendo la scadenza, cioè
 * lasciando le adesioni aperte per sempre.
 *
 * ── PERCHÉ UN MODULO, E NON TRE RIGHE DENTRO LE ROTTE ───────────────────────
 *
 * Perché le strade che devono rispondere «è scaduto?» sono già quattro — POST,
 * PUT, la lettura del genitore, la RPC dell'adesione — e questo repo ha misurato
 * due volte che cosa succede a una regola scritta più di una volta:
 * `classiMancantiNellaSede` è nata dentro il POST e il PUT non l'ha mai avuta
 * (10 alunni, 10 genitori, **0 raggiunti**), e il tetto del titolo è stato chiuso
 * sui promemoria e lasciato aperto sugli avvisi. Una regola che vale per due
 * strade vive in un posto solo, o la seconda strada resta indietro per sempre.
 *
 * ── IL DIFETTO CHE `avvisoScaduto` CHIUDE ───────────────────────────────────
 *
 * `AvvisoCard.tsx:91` fa oggi:
 *
 *     const isExpired = avviso.scadenza && new Date(avviso.scadenza) < new Date()
 *
 * `new Date('2026-09-19')` è mezzanotte **UTC**, cioè le 02:00 italiane d'estate.
 * Dalle 02:00 del 19 settembre in poi, un avviso che scade il 19 settembre
 * risulta **già morto il giorno in cui doveva essere ancora vivo**: la card si
 * mostra scaduta per ventidue ore su ventiquattro dell'ultimo giorno utile. È lo
 * stesso scarto che il 2026-08-01 alle 01:08 ha fatto sparire un incasso vero da
 * un KPI, e per cui esistono `dataCivile()` e `confini-giorno.ts`.
 *
 * ── I GEMELLI IN SQL, DICHIARATI ────────────────────────────────────────────
 *
 * ⚠️ `adesioniChiuse` è il gemello del `COALESCE(scadenza_adesione,
 * scadenza_avviso)` che il cantiere A2 scrive dentro la RPC dell'adesione. Sono
 * la stessa regola in due linguaggi: **quella decide chi entra, questa decide che
 * cosa vede chi guarda**. Se divergono, il modulo mostra il bottone «Aderisci» e
 * la RPC risponde che è chiuso — oppure, peggio nel verso opposto, il bottone
 * sparisce mentre il database accetterebbe ancora. Nessun test se ne accorge,
 * perché ciascuna delle due metà, da sola, è coerente. Chi tocca il `COALESCE`
 * là dentro tocca anche questa funzione.
 */

export type EsitoScadenze =
    | { ok: true; scadenzaAvviso: string; scadenzaAdesione: string | null }
    | {
          ok: false;
          codice:
              | 'SCADENZE_INCOERENTI'
              | 'SCADENZA_ADESIONE_MANCANTE'
              | 'SCADENZA_AVVISO_MANCANTE'
              | 'SCADENZA_NEL_PASSATO';
      };

/** `''`/`null`/`undefined` sono la stessa cosa: un campo che la segreteria non ha compilato. */
function vuoto(v: string | null | undefined): boolean {
    return v === null || v === undefined || v.trim() === '';
}

/**
 * LE DUE SCADENZE DAL CORPO DELLA RICHIESTA AI DUE ISTANTI DA ARCHIVIARE.
 *
 * Riceve le cifre locali italiane (`YYYY-MM-DDTHH:MM`, ciò che `zScadenzaAvvisoDataOra`
 * lascia passare) e restituisce gli istanti ISO, oppure il codice del rifiuto. Il
 * chiamante traduce il codice in un messaggio: qui non si scrive testo per un
 * essere umano, perché questa funzione serve a due rotte e a un test e nessuno dei
 * tre parla la stessa lingua dell'altro.
 *
 * ── L'ORDINE DEI CONTROLLI È PARTE DEL CONTRATTO ────────────────────────────
 *
 * mancante → mancante → coerenza → passato. Prima l'esistenza, poi il rapporto
 * fra i due, poi il rapporto con l'adesso. All'incontrario, una segreteria che
 * sbaglia due cose insieme riceverebbe come primo messaggio quello meno utile:
 * «la scadenza è nel passato» detto di un campo che non ha ancora compilato.
 *
 * ── `vietaPassato` VALE SOLO SUL POST ───────────────────────────────────────
 *
 * ⚠️ Sul PUT una scadenza nel passato **non è un errore: è il gesto**. È così che
 * la segreteria chiude SUBITO un avviso — la gita è annullata, le adesioni si
 * fermano adesso — e senza quel gesto l'unica alternativa sarebbe cancellare
 * l'avviso, cioè buttare via anche le adesioni già raccolte e le prese visione.
 * Sul POST invece un avviso che nasce già scaduto è sempre uno sbaglio di
 * digitazione: nessuno pubblica qualcosa perché nessuno lo veda.
 *
 * `adessoISO` arriva dal chiamante e non da `new Date()` qui dentro: è ciò che
 * rende questa funzione provabile senza congelare l'orologio dell'intero test, e
 * ciò che permette a una rotta di usare lo STESSO istante per tutti i controlli
 * di una richiesta invece di uno leggermente diverso per ciascuno.
 */
export function risolviScadenze(input: {
    tipo: string | null;
    scadenzaAvvisoLocale: string | null | undefined;
    scadenzaAdesioneLocale: string | null | undefined;
    vietaPassato: boolean;
    adessoISO: string;
}): EsitoScadenze {
    const { tipo, scadenzaAvvisoLocale, scadenzaAdesioneLocale, vietaPassato, adessoISO } = input;

    if (vuoto(scadenzaAvvisoLocale)) return { ok: false, codice: 'SCADENZA_AVVISO_MANCANTE' };
    const scadenzaAvviso = istanteDaLocale(scadenzaAvvisoLocale as string);
    // Una forma illeggibile qui NON lancia, a differenza di `avvisoScaduto`: questo
    // valore arriva dal CLIENT, e un'eccezione lo trasformerebbe in un 500 — cioè
    // «è colpa mia» detto di uno sbaglio di chi manda la richiesta, che è
    // esattamente il 400-travestito-da-500 per cui esiste `@/lib/validation/avvisi`.
    // `zScadenzaAvvisoDataOra` l'ha già rifiutata con un messaggio che dice DOVE è
    // lo sbaglio; se arriva fin qui è perché una rotta ha saltato lo schema, e lo
    // stato che resta è comunque «nessuna scadenza utilizzabile».
    //
    // ── PERCHÉ «MANCANTE» SU UN CAMPO COMPILATO, E PERCHÉ NON SI SDOPPIA ───────
    //
    // ⚠️ Il codice dice «manca» di un campo che c'è: `'2026-06-01T99:99'` esce di
    // qui come `SCADENZA_AVVISO_MANCANTE`. Non è una svista — è l'unico stato che
    // resta — ma il TESTO mostrato non poteva restare «senza questa data e ora
    // l'avviso non viene salvato», perché mandava la segreteria a cercare un campo
    // vuoto che aveva invece riempito. La frase adesso copre onestamente i due casi
    // («se manca o non è valida»), e vive dove vivono tutte le frasi:
    // `erroreScadenzaAvvisoMancante` in `messages/{it,en}/shared.json`.
    //
    // Un codice a parte — `SCADENZA_AVVISO_NON_LEGGIBILE` — è stato VALUTATO E
    // SCARTATO, e la ragione va scritta perché il prossimo che passa non rifaccia
    // il giro: questo ramo **non è raggiungibile da una rotta che usa lo schema**.
    // `istanteDaLocale` torna `null` esattamente sulle stringhe che `zDataOraLocale`
    // rifiuta — dal 2026-09-19 condividono la STESSA `FORMA_DATA_ORA_LOCALE`
    // (`@/lib/format/confini-giorno`) e la stessa verifica di calendario, quindi
    // l'equivalenza non è una coincidenza da riverificare ogni volta: è una
    // costante importata. Un secondo codice sarebbe quindi due voci di catalogo in
    // due lingue per una frase che nessun utente può leggere, e una biforcazione in
    // più da tenere allineata su POST, PUT, RPC e modulo.
    //
    // ⚠️ Resta un angolo dichiarato: più sotto, una scadenza d'adesione illeggibile
    // su un avviso che NON è di tipo `adesione` esce come `SCADENZE_INCOERENTI`, e
    // quella frase parla di due date in ordine sbagliato — falsa, su un valore che
    // non è una data. Vale lo stesso ragionamento (dietro lo schema non si arriva),
    // e lo si nomina qui invece di lasciarlo trovare: chi un giorno esporrà queste
    // funzioni senza zod davanti deve sistemare entrambi i rami, non solo questo.
    if (scadenzaAvviso === null) return { ok: false, codice: 'SCADENZA_AVVISO_MANCANTE' };

    const serveAdesione = tipo === 'adesione';
    if (serveAdesione && vuoto(scadenzaAdesioneLocale)) {
        // Un avviso di adesione senza termine per aderire è un modulo che non si
        // chiude mai: le risposte continuano ad arrivare dopo la gita, e chi deve
        // contare i posti non ha un momento in cui il numero smette di muoversi.
        return { ok: false, codice: 'SCADENZA_ADESIONE_MANCANTE' };
    }

    let scadenzaAdesione: string | null = null;
    if (!vuoto(scadenzaAdesioneLocale)) {
        scadenzaAdesione = istanteDaLocale(scadenzaAdesioneLocale as string);
        if (scadenzaAdesione === null) {
            // Illeggibile: se era obbligatoria manca davvero, se non lo era il
            // chiamante ha comunque mandato qualcosa che non è una data e non lo
            // si archivia in silenzio come `null`.
            return serveAdesione
                ? { ok: false, codice: 'SCADENZA_ADESIONE_MANCANTE' }
                : { ok: false, codice: 'SCADENZE_INCOERENTI' };
        }
        // ⚠️ `>` e non `>=`: l'UGUAGLIANZA È AMMESSA. «Le adesioni si chiudono
        // quando l'avviso sparisce» è la configurazione più naturale che esista —
        // ed è quella che la segreteria ottiene copiando la stessa data nei due
        // campi, cosa che farà spesso. Un `>=` la rifiuterebbe con un messaggio
        // incomprensibile («le scadenze sono incoerenti» su due date identiche).
        if (Date.parse(scadenzaAdesione) > Date.parse(scadenzaAvviso)) {
            return { ok: false, codice: 'SCADENZE_INCOERENTI' };
        }
    }

    if (vietaPassato) {
        // Si controllano ENTRAMBE: un avviso che nasce visibile ma con le adesioni
        // già chiuse è lo stesso sbaglio di digitazione, e lascerebbe i genitori
        // davanti a un modulo che non accetta risposte.
        if (avvisoScaduto(scadenzaAvviso, adessoISO)) return { ok: false, codice: 'SCADENZA_NEL_PASSATO' };
        if (scadenzaAdesione !== null && avvisoScaduto(scadenzaAdesione, adessoISO)) {
            return { ok: false, codice: 'SCADENZA_NEL_PASSATO' };
        }
    }

    return { ok: true, scadenzaAvviso, scadenzaAdesione };
}

/**
 * È PASSATO IL MOMENTO IN CUI QUESTO AVVISO SPARISCE?
 *
 * `null` → `false`: un avviso senza scadenza non scade. Non è una tolleranza, è
 * il significato della colonna vuota — ed è il caso della gran parte dei record
 * storici.
 *
 * ── LA SCADENZA È L'ULTIMO ISTANTE VALIDO, INCLUSO ──────────────────────────
 *
 * L'avviso è visibile finché `adesso <= scadenza`, cioè il confronto è `>` e mai
 * `>=`. All'istante esatto della scadenza l'avviso è ancora VIVO; sparisce il
 * millisecondo dopo. È lo stesso contratto di `fineGiornoCivile`, dove
 * `23:59:59.999` è l'ultimo istante vivo del giorno e non il primo morto — e non
 * il contrario, come questo riquadro ha sostenuto fino al 2026-09-19.
 *
 * ⚠️ E LA GEMELLANZA SI DICHIARA SULL'OPERATORE, non solo sul `COALESCE`.
 * Questa regola vive in TRE posti, e l'assenza di questa riga è ciò che aveva
 * reso invisibile una divergenza vera:
 *
 *   1. `avvisoScaduto` qui sotto ...................  `adesso >  scadenza`
 *   2. la RPC dell'adesione (cantiere A2, migrazione
 *      20260919132612, `avviso_adesione_registra`) ..  `v_ora  >  v_termine`
 *   3. il filtro del feed, che lo scrive un altro
 *      cantiere .......... `.gte('scadenza_avviso', adesso)`, **mai** `.gt`
 *
 * Il punto 3 è la terza metà dello stesso gemello e va detto qui perché chi lo
 * scriverà non passerà da questo file: `.gte` tiene dentro l'avviso che scade
 * nell'istante esatto della query, `.gt` lo butterebbe fuori — cioè il feed
 * mostrerebbe una cosa e questa funzione ne direbbe un'altra sullo stesso
 * millisecondo. Chi cambia uno dei tre operatori li cambia TUTTI E TRE.
 *
 * ── LA DIVERGENZA CHE C'ERA, E PERCHÉ NESSUN TEST LA VEDEVA ─────────────────
 *
 * Fino al 2026-09-19 questa stessa funzione usava `>` sul ramo «data pura»
 * («alle 23:59:59.999 l'avviso è ancora vivo») e `>=` sul ramo «istante» — che è
 * l'unico che conterà dopo la migrazione del cantiere A2, perché è lì che finisce
 * `scadenza_avviso`. Due metà ciascuna coerente **con sé stessa**: la forma di
 * difetto che questo repo ha già pagato due volte, e che un test per ramo non
 * può trovare, perché per trovarla bisogna confrontare i due rami fra loro.
 *
 * ── UNA DATA PURA VALE FINO A SERA ──────────────────────────────────────────
 *
 * ⚠️ Accetta ANCHE `YYYY-MM-DD`, e la tratta come **fine del giorno civile
 * italiano** (`fineGiornoCivile`). Non è una comodità: è l'unica lettura che
 * chiunque abbia mai dato a quel campo. Nessuna segreteria che ha scritto
 * «scadenza: 19 settembre» intendeva «fino all'01:59 del 19»; intendeva tutto il
 * 19. Le righe con la vecchia colonna `scadenza date` restano in tabella dopo la
 * migrazione del cantiere A2, e passano da qui.
 *
 * È il difetto di `AvvisoCard.tsx:91` (`new Date('2026-09-19')` = mezzanotte UTC
 * = le 02:00 italiane), spiegato per esteso nella testata di questo modulo.
 *
 * ── UNA STRINGA MALFORMATA LANCIA ───────────────────────────────────────────
 *
 * ⚠️ E non vale «non scaduto». Un parse fallito che scivola via come `false`
 * significa **adesioni riaperte a tutti** e un avviso che non sparisce più dalla
 * bacheca: il silenzio più caro che questo codice possa produrre. Qui il valore
 * arriva dal DATABASE, non da un client — se non è una data, il difetto è nostro
 * e va visto, non assorbito. Chi RIEMPIE un campo dell'interfaccia usa invece
 * `oraCivile`, che su un valore illeggibile torna `''`: lì un vuoto si vede,
 * qui un `false` no.
 */
export function avvisoScaduto(scadenzaAvvisoISO: string | null, adessoISO: string): boolean {
    if (scadenzaAvvisoISO === null || scadenzaAvvisoISO === undefined) return false;

    const adesso = Date.parse(adessoISO);
    if (Number.isNaN(adesso)) throw new Error(`avvisoScaduto: istante «adesso» non leggibile: ${adessoISO}`);

    // Data pura: il confine è l'ULTIMO millisecondo del giorno italiano, quindi
    // `>` e non `>=` — alle 23:59:59.999 del 19 l'avviso è ancora vivo.
    if (/^\d{4}-\d{2}-\d{2}$/.test(scadenzaAvvisoISO)) {
        const fine = fineGiornoCivile(scadenzaAvvisoISO);
        if (fine === null) {
            throw new Error(`avvisoScaduto: data di scadenza inesistente nel calendario: ${scadenzaAvvisoISO}`);
        }
        return adesso > Date.parse(fine);
    }

    const scadenza = Date.parse(scadenzaAvvisoISO);
    if (Number.isNaN(scadenza)) {
        throw new Error(`avvisoScaduto: scadenza non leggibile: ${scadenzaAvvisoISO}`);
    }
    // `>` e non `>=`, come il ramo «data pura» qui sopra e come il `v_ora >
    // v_termine` della RPC: la scadenza è l'ultimo istante VALIDO, incluso.
    return adesso > scadenza;
}

/**
 * SI PUÒ ANCORA ADERIRE?
 *
 * ⚠️ Ripiega su `scadenza_avviso` quando `scadenza_adesione` è `null` — **gemello
 * del `COALESCE(scadenza_adesione, scadenza_avviso)` della RPC dell'adesione**
 * (cantiere A2). Il ripiego non è una scorciatoia: è la sola lettura difendibile
 * dei record storici, che hanno un campo solo. Senza di esso ogni avviso
 * pubblicato prima della migrazione avrebbe le adesioni aperte per sempre, anche
 * quello sparito dalla bacheca sei mesi fa.
 *
 * Con entrambi i campi vuoti torna `false`: nessuna scadenza, nessuna chiusura —
 * la stessa risposta che dà `avvisoScaduto`, e per la stessa ragione.
 */
export function adesioniChiuse(
    row: { scadenza_adesione: string | null; scadenza_avviso: string | null },
    adessoISO: string,
): boolean {
    const limite = row.scadenza_adesione ?? row.scadenza_avviso;
    return avvisoScaduto(limite, adessoISO);
}
