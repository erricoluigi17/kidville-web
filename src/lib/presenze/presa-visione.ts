/**
 * LA PRESA VISIONE VALE PER IL TESTO CHE IL DOCENTE HA LETTO.
 *
 * Sta in un modulo suo, e non dentro una delle due route, per la ragione che
 * questo repo ha già pagato due volte: **una regola valida per due strade deve
 * vivere in un posto solo**. Le strade che scrivono
 * `presenze.giustificazione_testo` sono due —
 *
 *   · `parent/presenze/comunica-assenza:POST` — l'assenza annunciata in anticipo;
 *   · `parent/presenze/giustifica:POST`       — la giustifica firmata a posteriori.
 *
 * ─── IL DIFETTO, E PERCHÉ ERA INVISIBILE (rilievo Q5) ────────────────────────
 *
 * `giustifica` azzerava `giust_vista_il`/`giust_vista_da` a ogni scrittura e lo
 * dichiarava in un commento. `comunica-assenza` non nominava quelle colonne in
 * NESSUNO dei suoi due payload — e PostgREST aggiorna **solo le colonne
 * nominate**, quindi la presa visione sopravviveva a ogni ricomunicazione: la
 * riga risultava «già letta dal docente» mentre il testo che il docente aveva
 * letto era stato sostituito da un altro.
 *
 * La finestra in cui accade esiste davvero: `primaria/presenze/giust-vista:POST`
 * NON scrive `registrato_da`, quindi il docente può prendere visione prima di
 * salvare l'appello, e finché `registrato_da` è nullo il genitore può ancora
 * sovrascrivere il motivo (l'UPDATE condizionato passa).
 *
 * ─── PERCHÉ AZZERARE È GIUSTO ───────────────────────────────────────────────
 *
 * Perché la presa visione è la lettura di UN testo, e il testo è cambiato: un
 * docente che ha letto «visita di controllo» non ha letto «febbre alta da tre
 * giorni». Lasciare la marca significa dire alla scuola che qualcuno ha visto
 * una cosa che nessuno ha visto — e su un dato di natura sanitaria di un minore.
 *
 * ─── MA SOLO SE IL TESTO CAMBIA DAVVERO ─────────────────────────────────────
 *
 * Una ricomunicazione a motivo invariato (o senza motivo: `comunica-assenza` non
 * nomina la colonna quando il campo è vuoto, per non cancellare il testo
 * archiviato) non deve far perdere al docente una lettura legittima. Il
 * confronto si fa sul valore NORMALIZZATO, che è quello che arriva in tabella.
 *
 * ─── E SI DICE A QUALCUNO ───────────────────────────────────────────────────
 *
 * Azzerare in silenzio sposterebbe soltanto il difetto: il docente aveva letto,
 * non lo sa più nessuno, e nessuno glielo dice. `presaVisioneRevocata` esiste per
 * questo: quando una lettura ESISTENTE viene tolta, la notifica ai docenti della
 * sezione non si lascia collassare dal `debounce` — vedi `comunica-assenza`.
 */

/** La parte di riga che serve a decidere. Nessun'altra colonna va letta. */
export interface RigaPresaVisione {
    /** Il testo ARCHIVIATO, cioè quello su cui la presa visione è stata data. */
    giustificazione_testo?: string | null;
    /** Quando il docente ha dichiarato di aver letto (null = mai). */
    giust_vista_il?: string | null;
}

/**
 * Il testo che finirà in tabella è diverso da quello che c'era?
 *
 * `undefined` significa «la scrittura non nomina la colonna», ed è un caso
 * concreto, non teorico: con il motivo vuoto `comunica-assenza` omette
 * `giustificazione_testo` dall'UPDATE apposta per non azzerare un dato sanitario
 * che nessuno ha chiesto di cancellare. Se non si scrive niente, non si
 * invalida niente.
 *
 * `null` e `''` sono la stessa cosa — «nessun motivo» — perché è così che
 * `motivoNormalizzato` li fa arrivare al database.
 */
export function testoCambiato(
    precedente: string | null | undefined,
    nuovo: string | null | undefined,
): boolean {
    if (nuovo === undefined) return false;
    return (precedente ?? '') !== (nuovo ?? '');
}

/**
 * Le colonne da fondere nel payload di scrittura — vuoto quando non c'è niente
 * da invalidare.
 *
 * Le due colonne viaggiano SEMPRE insieme: `giust_vista_il` senza
 * `giust_vista_da` lascerebbe l'identificativo di un docente appeso a una
 * lettura che non risulta più avvenuta.
 */
export const PRESA_VISIONE_AZZERATA: { giust_vista_il: null; giust_vista_da: null } = {
    giust_vista_il: null,
    giust_vista_da: null,
};

export function azzeramentoPresaVisione(
    precedente: string | null | undefined,
    nuovo: string | null | undefined,
): { giust_vista_il: null; giust_vista_da: null } | Record<string, never> {
    return testoCambiato(precedente, nuovo) ? { ...PRESA_VISIONE_AZZERATA } : {};
}

/**
 * Si sta togliendo una presa visione che ESISTEVA: c'è un docente che aveva
 * letto e che va riavvisato.
 *
 * Distinto da `azzeramentoPresaVisione` di proposito: azzerare una colonna già
 * nulla non è un evento e non deve svegliare nessuno.
 */
export function presaVisioneRevocata(
    riga: RigaPresaVisione | null | undefined,
    nuovo: string | null | undefined,
): boolean {
    if (!riga?.giust_vista_il) return false;
    return testoCambiato(riga.giustificazione_testo, nuovo);
}
