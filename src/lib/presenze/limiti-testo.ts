/**
 * I LIMITI DEL TESTO LIBERO SCRITTO DA UN GENITORE SUL REGISTRO.
 *
 * Sta in un modulo suo, e non dentro una delle due route, per la ragione che questo repo ha
 * già pagato una volta: **una regola valida per due strade deve vivere in un posto solo**.
 * Le strade che scrivono `presenze.giustificazione_testo` sono due e fanno la stessa cosa con
 * due gesti diversi —
 *
 *   · `parent/presenze/comunica-assenza:POST` — l'assenza annunciata in anticipo;
 *   · `parent/presenze/giustifica:POST`       — la giustifica firmata a posteriori.
 *
 * Il collaudo del 2026-08-07 (rilievo M14) ha misurato il tetto assente su entrambe: un
 * `motivo` di **200.000 caratteri** accettato con un 201, restituito per intero al client del
 * genitore e alle viste dei docenti. La prima correzione ha chiuso solo la prima strada, e il
 * rilievo lo diceva già: *«il tetto va anche sul gemello, che scrive la stessa colonna»*. Con
 * due costanti separate la prossima divergenza sarebbe silenziosa.
 */

/**
 * Caratteri ammessi nel motivo dell'assenza.
 *
 * 500 è la misura che questo repo usa già per il testo libero scritto da un genitore —
 * `mensa/alternative` (`richiesta`), `merch/ordini` (`note`), `merch/articoli`
 * (`descrizione`) — ed è il posto giusto in cui stare: «febbre» e «visita medica dal
 * dentista, rientra dopo pranzo» ci stanno dentro dieci volte.
 *
 * Non è una comodità di validazione: `giustificazione_testo` è testo libero di natura
 * sanitaria su un MINORE (art. 9), e la minimizzazione (art. 5.1.c) si impone alla fonte.
 */
export const MOTIVO_MAX_CARATTERI = 500;

/**
 * Il motivo come finisce in tabella, oppure `null`.
 *
 * Normalizza UNA VOLTA SOLA e nello stesso modo sulle due route: `trim`, e ciò che resta
 * vuoto è `null` — non `''`. Le due strade lo scrivevano già così, ma ciascuna per conto
 * suo; la misura del tetto si fa su QUESTO valore, che è quello che arriva al database:
 * rifiutare per gli spazi in coda sarebbe un rifiuto che il genitore non può capire
 * guardando ciò che ha scritto.
 *
 * Permissiva sul TIPO di proposito: entrambi gli schemi dichiarano `motivo: z.unknown()`
 * perché lo schema decide PRIMA del gate di parentela, e un 400 emesso lì scavalcherebbe il
 * 403 sul figlio altrui. Qualunque cosa non sia una stringa vale «nessun motivo».
 */
export function motivoNormalizzato(motivo: unknown): string | null {
    return typeof motivo === 'string' ? motivo.trim() || null : null;
}
