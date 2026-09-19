import { z } from 'zod';
import { zDataOraLocale, zDataYMD } from '@/lib/validation/common';

// =============================================================================
// I LIMITI DI LUNGHEZZA DI `avvisi`, PRESI DAL DDL.
//
// Gemello di `task-interni.ts`, e per lo stesso rilievo (backend F1 del collaudo
// del 2026-07-31). Quel rilievo è stato chiuso il 1° agosto **solo sui
// promemoria**: `POST /api/avvisi` è rimasto con `z.string().min(1)` e senza
// massimo, quindi il difetto era ancora riproducibile parola per parola:
//
//   POST /api/avvisi  { titolo: 'A'.repeat(100000) }
//     → HTTP 500 {"error":"value too long for type character varying(255)"}
//
// Due danni in uno: è un **400 di validazione travestito da 500** («è colpa mia»
// invece di «i dati non vanno bene»), e la risposta **racconta al client il tipo
// esatto della colonna**.
//
// Che sia rimasto aperto proprio qui non è un caso: gli avvisi e i promemoria
// sono stati corretti da due esecutori diversi, e chi aveva in mano `tasks` non
// aveva motivo di guardare `avvisi`. È la stessa forma del difetto del PUT
// (`@/lib/avvisi/classi-sede`): una regola chiusa su una strada e lasciata aperta
// su quella accanto.
//
// I VALORI VENGONO DALLA COLONNA, misurati sul database di produzione il
// 2026-08-01 (`information_schema.columns`), non da una stima di quanto sia
// «ragionevole» un titolo:
//
//     titolo       character varying(255)
//     tipo         character varying(20)
//     target_scope character varying(20)
//
// Un massimo più stretto della colonna rifiuterebbe dati legittimi; uno più largo
// lascerebbe il difetto aperto per i valori intermedi (256…100000).
//
// `contenuto` NON ha limite: in tabella è `text`, senza larghezza.
//
// NOTA SUL CONTEGGIO, come nei promemoria: Postgres conta CARATTERI, JavaScript
// unità UTF-16 (`'😀'.length` è 2 per JS e 1 per Postgres). Quindi `.max(255)` su
// `String.length` è sempre ALMENO severo quanto la colonna, mai più largo. Dopo
// questa dichiarazione un `22001` che arrivasse comunque da PostgREST non sarebbe
// più un errore del chiamante ma la prova che il DDL e questo file hanno
// divergiuto: resta perciò un **500**, che è la verità.
// =============================================================================

/** `avvisi.titolo character varying(255)` */
export const MAX_TITOLO_AVVISO = 255;
/** `avvisi.tipo character varying(20)` */
export const MAX_TIPO_AVVISO = 20;
/** `avvisi.target_scope character varying(20)` */
export const MAX_TARGET_SCOPE_AVVISO = 20;
/**
 * `sections.name character varying(50)` — il valore che finisce dentro
 * `avvisi.target_classes` è un NOME di sezione, non un id.
 */
export const MAX_CLASSE_AVVISO = 50;

/**
 * Il titolo dell'avviso. Porta anche il `.min(1)`: a differenza dei promemoria,
 * entrambe le rotte degli avvisi (POST e PUT) esigono il titolo — il PUT non è un
 * merge parziale, riscrive la riga per intero.
 */
export const zTitoloAvviso = z
    .string()
    .min(1, 'titolo e contenuto sono obbligatori')
    .max(MAX_TITOLO_AVVISO, `Il titolo non può superare ${MAX_TITOLO_AVVISO} caratteri`);

/** Il corpo dell'avviso: `text` in tabella, quindi nessun massimo di colonna. */
export const zContenutoAvviso = z.string().min(1, 'titolo e contenuto sono obbligatori');

/** `presa_visione` | `adesione` — la larghezza è quella della colonna, non l'elenco dei valori. */
export const zTipoAvviso = z
    .string()
    .max(MAX_TIPO_AVVISO, `Il tipo non può superare ${MAX_TIPO_AVVISO} caratteri`);

/** `globale` | `classe`. */
export const zTargetScopeAvviso = z
    .string()
    .max(MAX_TARGET_SCOPE_AVVISO, `Il destinatario non può superare ${MAX_TARGET_SCOPE_AVVISO} caratteri`);

/**
 * La scadenza dell'avviso.
 *
 * ⚠️ AGGIUNTA IL 2026-08-01, DOPO IL COLLAUDO, e la ragione per cui mancava vale
 * più della correzione. La prima stesura di questo modulo ha chiuso il rilievo S34
 * guardando **quali colonne hanno una LARGHEZZA** — le `character varying` — e non
 * **quali colonne hanno un FORMATO**. `scadenza` è una `date`: nessun `.max()` da
 * scrivere, quindi è scivolata via, e una stringa qualunque continuava a produrre
 *
 *     500 {"error":"…"}  ·  log: 22007 invalid input syntax for type date: "…"
 *
 * cioè lo stesso 400-travestito-da-500 che S34 dichiarava chiuso, su un'altra
 * colonna della stessa tabella. Un criterio applicato per come è fatto il tipo, e
 * non per che cosa può arrivare dal client, lascia sempre fuori qualcosa.
 *
 * `zDataYMD` è lo schema già in uso nel progetto (cassa, mensa, presenze): non se
 * ne scrive un secondo.
 *
 * @deprecated Usa `zScadenzaAvvisoDataOra`. Una scadenza a GRANA GIORNO non basta
 * più: dal momento in cui la scadenza dell'avviso e quella dell'adesione sono due
 * momenti distinti, «il 19 settembre» non dice quando l'avviso sparisce dalla
 * bacheca — e la risposta implicita («a mezzanotte») è quella che nessuno scrive
 * mai e ognuno interpreta a modo suo. Resta esportato perché
 * `POST /api/avvisi` e `PUT /api/avvisi/[id]` lo importano ancora
 * (`.nullish()`, entrambe): le riscrive un altro cantiere, e toglierlo adesso
 * romperebbe la build di due rotte per un rinominamento.
 */
export const zScadenzaAvviso = zDataYMD;

// =============================================================================
// SCADENZE, PARTECIPANTI E POSTI — I NUMERI VENGONO DAL DDL, COME SOPRA.
//
// Stessa disciplina della testata di questo file: i massimi non sono una stima di
// quanto sia «ragionevole» un accompagnatore, sono la copia dichiarata dei
// vincoli che il cantiere A2 scrive nella migrazione:
//
//     numero_min  smallint NOT NULL DEFAULT 1
//     numero_max  smallint NOT NULL DEFAULT 20
//     CHECK (numero_min >= 1 AND numero_max >= numero_min AND numero_max <= 999)
//
// ⚠️ SONO GEMELLI PINNATI. Queste costanti e quel `CHECK` sono lo stesso numero
// scritto in due linguaggi, e come ogni coppia del genere possono divergere in
// silenzio: se il DDL salisse a 1500 e qui restasse 999, il modulo rifiuterebbe
// con un 400 dati che il database accetta — e nessun test se ne accorgerebbe,
// perché ciascuna delle due metà, da sola, è coerente. Il lock che li confronta
// lo scrive il cantiere D1 (legge il file di migrazione come testo e cerca i
// numeri di qui). Finché quel lock non esiste, chi cambia un numero cambia
// entrambi i posti a mano.
//
// È la stessa forma di gemello del `COALESCE(numero_partecipanti, 1)` di
// `@/lib/avvisi/posti` e del `COALESCE` sulle scadenze di `@/lib/avvisi/scadenze`:
// ogni volta che una regola vive sia in SQL sia in TypeScript, la si dichiara
// gemella nel commento, o la si scopre divergente da un utente.
// =============================================================================

/**
 * La scadenza dell'avviso e quella dell'adesione: data E ora, locali italiane.
 *
 * Una scadenza senza ora è una scadenza a metà — vedi il `@deprecated` di
 * `zScadenzaAvviso` qui sopra. `zDataOraLocale` non accetta un ISO, e il perché
 * (l'orologio e il fuso del tablet) sta scritto per esteso lì.
 */
export const zScadenzaAvvisoDataOra = zDataOraLocale;

/** `CHECK (numero_min >= 1 …)` — un'adesione con zero persone non è un'adesione. */
export const NUMERO_PARTECIPANTI_MIN = 1;
/** `CHECK (… numero_max <= 999)` — il tetto assoluto della colonna. */
export const NUMERO_PARTECIPANTI_MAX_ASSOLUTO = 999;
/** `numero_max smallint NOT NULL DEFAULT 20` — il tetto che la segreteria trova già scritto. */
export const NUMERO_PARTECIPANTI_MAX_PREDEFINITO = 20;

/**
 * La domanda che accompagna il contatore, `character varying(120)`.
 *
 * Il tetto è quello della colonna e non un giudizio sulla prolissità: un massimo
 * più stretto rifiuterebbe dati legittimi, uno più largo lascerebbe il
 * 400-travestito-da-500 aperto per i valori intermedi. È il rilievo F1, di nuovo.
 */
export const MAX_ETICHETTA_NUMERO = 120;

/**
 * Il testo che compare se la segreteria accende il contatore e non scrive niente.
 *
 * Vive QUI e non nel catalogo i18n di proposito: non è una stringa d'interfaccia
 * ma un VALORE che finisce in colonna e che i genitori leggeranno anche fra due
 * anni, quando il catalogo sarà cambiato. Una scritta salvata non deve muoversi
 * sotto i piedi di chi l'ha letta.
 */
export const ETICHETTA_NUMERO_PREDEFINITA = 'Quante persone accompagneranno il bambino?';

/** L'etichetta del contatore: obbligatoria solo se il contatore è acceso (vedi `@/lib/avvisi/partecipanti`). */
export const zEtichettaNumero = z
    .string()
    .max(MAX_ETICHETTA_NUMERO, `L'etichetta non può superare ${MAX_ETICHETTA_NUMERO} caratteri`);

/**
 * Quante persone dichiara una famiglia. Intero, dentro il `CHECK` della colonna.
 *
 * `.int()` non è pleonastico: senza, `2.5` arriverebbe a una colonna `smallint` e
 * produrrebbe un 22P02 → 500. Il rapporto fra `numero_min` e `numero_max` — che è
 * un vincolo fra DUE campi, non su uno — non si può esprimere qui: lo verifica
 * `validaConfigurazione` in `@/lib/avvisi/partecipanti`, gemello della seconda
 * metà del `CHECK`.
 */
export const zNumeroPartecipanti = z.coerce
    .number({ error: 'Numero di partecipanti non valido' })
    .int('Il numero di partecipanti deve essere un numero intero')
    .min(NUMERO_PARTECIPANTI_MIN, `Il numero di partecipanti deve essere almeno ${NUMERO_PARTECIPANTI_MIN}`)
    .max(
        NUMERO_PARTECIPANTI_MAX_ASSOLUTO,
        `Il numero di partecipanti non può superare ${NUMERO_PARTECIPANTI_MAX_ASSOLUTO}`,
    );

/**
 * Il tetto di posti dell'avviso, contato IN PERSONE (non in famiglie).
 *
 * Il minimo è 1 e non 0: un avviso di adesione con zero posti non è «chiuso», è un
 * avviso che non doveva essere pubblicato — e chi vuole chiudere le adesioni ha la
 * scadenza, che è il gesto giusto perché lascia leggibile ciò che è già stato
 * raccolto. `null` (campo assente) significa **nessun tetto**, che è il caso
 * normale: la maggioranza degli avvisi non ha posti limitati.
 */
export const zPostiTotali = z.coerce
    .number({ error: 'Numero di posti non valido' })
    .int('Il numero di posti deve essere un numero intero')
    .min(1, 'I posti disponibili devono essere almeno 1');

/**
 * `ammessa` | `in_attesa` — lo stato di UNA adesione rispetto al tetto di posti.
 *
 * ⚠️ È uno `z.enum` e non un `z.string().max(20)` come `zTipoAvviso` qui sopra, e
 * la differenza è voluta: `tipo` e `target_scope` sono colonne `varying` il cui
 * elenco di valori è cresciuto nel tempo, mentre questo stato decide **chi entra
 * e chi resta fuori**. Un terzo valore arrivato per sbaglio da un client non deve
 * poter essere archiviato e poi contato — o non contato — da
 * `@/lib/avvisi/posti`, che riconosce solo `ammessa`.
 */
export const zStatoAdesione = z.enum(['ammessa', 'in_attesa'], {
    error: "Stato dell'adesione non valido",
});

/**
 * I CAMPI DELL'ADESIONE CONDIVISI DA POST E PUT — una definizione sola.
 *
 * ⚠️ Non è pigrizia, è il rilievo che questo modulo porta scritto in testa due
 * volte: `classiMancantiNellaSede` è nata dentro il POST e il PUT non l'ha mai
 * avuta (`@/lib/avvisi/classi-sede`), e il tetto di lunghezza del titolo è stato
 * chiuso sui promemoria e lasciato aperto sugli avvisi. **Una regola che vale per
 * due strade, scritta due volte, resta indietro su una delle due** — non in
 * teoria: qui è successo due volte su due.
 *
 * Si spande dentro lo schema della rotta, così i due corpi non possono divergere:
 * ```ts
 * const bodySchema = z.object({
 *     titolo: zTitoloAvviso,
 *     scadenza_avviso: zScadenzaAvvisoDataOra,
 *     ...formaAdesioneAvviso,
 * })
 * ```
 *
 * Tutti `.nullish()` perché tutti facoltativi SUL FILO: un avviso di presa visione
 * non ne manda nessuno. Le obbligatorietà vere sono condizionate — `scadenza_adesione`
 * lo è solo se `tipo === 'adesione'`, `etichetta_numero` solo se `chiedi_numero` —
 * e uno schema zod non è il posto per esprimerle: quei vincoli guardano ALTRI
 * campi, e vivono in `@/lib/avvisi/scadenze` e `@/lib/avvisi/partecipanti` dove
 * anche il PUT li trova.
 */
export const formaAdesioneAvviso = {
    scadenza_adesione: zScadenzaAvvisoDataOra.nullish(),
    chiedi_numero: z.boolean({ error: 'Valore non valido per la richiesta del numero' }).nullish(),
    etichetta_numero: zEtichettaNumero.nullish(),
    numero_min: zNumeroPartecipanti.nullish(),
    numero_max: zNumeroPartecipanti.nullish(),
    posti_totali: zPostiTotali.nullish(),
} as const;

/**
 * Le classi destinatarie, come arrivano dal client.
 *
 * Prima era `z.unknown().optional()`: qualunque cosa passava, e la larghezza
 * dichiarata in `MAX_CLASSE_AVVISO` era una **costante morta** — scritta, mai
 * usata. Il collaudo l'ha misurato con un array di 3000 voci e con un nome di
 * classe da 100.000 caratteri: entrambi facevano fallire la query di verifica e
 * uscivano come 500, non come 400.
 *
 * `TETTO_CLASSI_AVVISO` non viene dal DDL — la colonna è un array senza limite —
 * ma dalla realtà: le sezioni di tutte e tre le sedi messe insieme sono 33. Cento
 * è un tetto che nessun uso legittimo raggiunge e che ferma l'abuso prima che
 * diventi una query da 30 KB.
 */
export const TETTO_CLASSI_AVVISO = 100;

export const zTargetClassesAvviso = z
    .array(
        z.string().max(MAX_CLASSE_AVVISO, `Il nome della classe non può superare ${MAX_CLASSE_AVVISO} caratteri`),
        { error: 'Le classi destinatarie devono essere un elenco di nomi' },
    )
    .max(TETTO_CLASSI_AVVISO, `Non si possono indicare più di ${TETTO_CLASSI_AVVISO} classi`);
