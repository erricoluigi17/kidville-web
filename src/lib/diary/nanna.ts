/**
 * ESTRATTORE CONDIVISO PER LA NANNA — gemello di `umore.ts`, e per la stessa ragione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO CHE LO FA NASCERE. Il salvataggio del diario (`DiaryEventEditor`) aveva
 * UN SOLO ramo selettivo, `umore`. Tutto il resto — nanna compresa — finiva nel ramo
 * `else`, che salva l'INTERO elenco dei bambini presenti. Quindi «Nanna» e «Sveglia»
 * scrivevano una riga in `eventi_diario` per ogni bambino, anche per chi aveva
 * `dettagli.orario_inizio = ''`, cioè il campo ora mai toccato.
 *
 * A valle, il genitore di un bambino che NON aveva dormito leggeva «Ho fatto un bel
 * sonnellino! 😴» — il ramo generico della narrativa, che nasce proprio quando l'ora
 * manca. Una frase falsa nel diario di suo figlio, ogni pomeriggio.
 *
 * PERCHÉ UNA LIBRERIA E NON TRE `if`. La regola «`''` non è un'ora» serve in tre
 * punti che oggi non si parlano: chi salva (il filtro del payload), chi rimette la ✅
 * riaprendo la schermata, e chi racconta la giornata al genitore. Scritta tre volte,
 * diverge alla prima modifica; è la lezione che questo repo ha già pagato più volte,
 * ed è il motivo per cui `umoreFromDettagli` esiste come unico estrattore.
 *
 * EFFETTO RETROATTIVO, ed è la parte che vale di più: le righe vuote GIÀ in archivio
 * non si cancellano — diventano inerti in tutti e tre i lettori nello stesso istante,
 * senza nessuna migrazione e senza toccare il diario di nessun bambino.
 *
 * COSA NON STA QUI. Le frasi del genitore. Vivono nel catalogo i18n
 * (`messages/it/diario.json`) e lì restano: portarle in una libreria condivisa
 * significherebbe toglierle la traduzione, che è l'errore opposto — quello che
 * `umoreNarrative` può permettersi solo perché nasce lato server, dove il locale
 * non esiste.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** I due campi ora che una registrazione di nanna può portare in `dettagli`. */
export type CampoNanna = 'orario_inizio' | 'orario_fine';

/**
 * I tipi evento che sono una nanna. Dichiarati QUI una volta sola: prima l'insieme
 * era scritto a mano in tre posti, in tre forme diverse.
 *
 * `nanna` senza suffisso è il tipo STORICO: non lo scrive più nessuno, ma sta nelle
 * righe vecchie e nella narrativa del genitore, che lo tratta come un `nanna_inizio`.
 * Dimenticarlo qui lascerebbe in archivio esattamente i sonnellini mai avvenuti che
 * questo modulo esiste per rendere inerti.
 */
const TIPI_NANNA: readonly string[] = ['nanna', 'nanna_inizio', 'nanna_fine'];

/** Questo tipo evento è una nanna? */
export function eEventoNanna(tipo: string): boolean {
    return TIPI_NANNA.includes(tipo);
}

/**
 * L'ora scritta in `dettagli`, o `null`.
 *
 * `null` per: campo assente, valore non stringa, stringa vuota, soli spazi. È
 * l'unico posto del progetto che sa che `''` — lo stato di un `<input type="time">`
 * mai toccato — NON è una registrazione. Non si valida il formato: qui la domanda
 * è «l'insegnante ha scritto qualcosa?», non «è un orario valido» (di quello si
 * occupa il campo del browser).
 */
export function oraNanna(
    dettagli: Record<string, unknown> | null | undefined,
    campo: CampoNanna,
): string | null {
    const v = dettagli?.[campo];
    if (typeof v !== 'string') return null;
    const pulita = v.trim();
    return pulita.length > 0 ? pulita : null;
}

/**
 * Questa registrazione di nanna è stata COMPILATA davvero?
 *
 * `nanna_inizio` → serve l'inizio. `nanna_fine` → serve la fine. `nanna` (storico) →
 * ne basta uno dei due, perché quella riga poteva portarli entrambi.
 *
 * Fail-closed su un tipo che nanna non è: la funzione la chiamano solo i punti che
 * trattano la nanna, e rispondere `true` a un `pranzo` significherebbe lasciar
 * passare per compilato un evento di cui questo modulo non sa niente.
 */
export function nannaCompilata(
    tipo: string,
    dettagli: Record<string, unknown> | null | undefined,
): boolean {
    if (!eEventoNanna(tipo)) return false;
    if (tipo === 'nanna_fine') return oraNanna(dettagli, 'orario_fine') !== null;
    if (tipo === 'nanna_inizio') return oraNanna(dettagli, 'orario_inizio') !== null;
    return oraNanna(dettagli, 'orario_inizio') !== null || oraNanna(dettagli, 'orario_fine') !== null;
}
