import { z } from 'zod';
import { zDataYMD } from '@/lib/validation/common';

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
 */
export const zScadenzaAvviso = zDataYMD;

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
