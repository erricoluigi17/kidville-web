/**
 * ─── QUANTE PERSONE, PER FAMIGLIA ────────────────────────────────────────────
 *
 * Un avviso di adesione può chiedere un NUMERO oltre al sì/no: «quante persone
 * accompagneranno il bambino?». Il contatore è facoltativo per avviso
 * (`chiedi_numero`) ma, se acceso, è obbligatorio per chi risponde — altrimenti
 * il tetto dei posti conterebbe adesioni senza sapere quante persone valgono, che
 * è il modo di riempire un pullman da 50 con 50 famiglie.
 *
 * I vincoli che stanno in UN campo li esprime zod (`zNumeroPartecipanti` in
 * `@/lib/validation/avvisi`: intero, 1…999). Quelli che guardano DUE campi non ci
 * stanno in uno schema, e sono i due che contano davvero:
 *
 *   · `numero_max >= numero_min` — la seconda metà del `CHECK` della colonna;
 *   · l'etichetta obbligatoria SE il contatore è acceso.
 *
 * ⚠️ Vivono qui, e qui soltanto, perché le strade che li applicano sono due (POST
 * e PUT) e questo repo ha già misurato due volte che cosa succede a una regola
 * scritta su una strada sola: `classiMancantiNellaSede` è nata nel POST e il PUT
 * non l'ha mai avuta (10 alunni, 10 genitori, **0 raggiunti**).
 */

/**
 * `numero_min smallint NOT NULL DEFAULT 1` — gemello pinnato del DDL del cantiere
 * A2, come le costanti di `@/lib/validation/avvisi`.
 *
 * Il predefinito vale UNO e non zero: «quante persone accompagneranno il
 * bambino?» con risposta zero non è un'adesione, è un no — e il no ha già il suo
 * campo.
 */
export const MIN_PREDEFINITO = 1;

/**
 * `numero_max smallint NOT NULL DEFAULT 20` — gemello pinnato del DDL.
 *
 * Venti e non 999: il 999 è il tetto della COLONNA (ciò che il database rifiuta),
 * questo è il tetto che la segreteria trova già scritto nel modulo e che può
 * alzare fino a lì. Confonderli farebbe comparire un campo con scritto «max 999»
 * in una scuola dove la famiglia più numerosa porta sei persone.
 */
export const MAX_PREDEFINITO = 20;

/**
 * L'intervallo EFFETTIVO di un avviso, con i predefiniti applicati.
 *
 * ⚠️ Esiste perché `null` in colonna e «nessun limite» non sono la stessa cosa, e
 * confonderli è il difetto che si vuole evitare: un `numero_max` nullo letto come
 * «illimitato» lascerebbe passare un'adesione da 400 persone su un pullman. `null`
 * qui significa «la segreteria non ha deciso», e chi non decide prende il
 * predefinito — lo stesso che il `DEFAULT` della colonna scriverebbe in SQL.
 * Gemelli, di nuovo: se il `DEFAULT` cambia là, cambia qui.
 *
 * Accetta `undefined` oltre a `null` perché il corpo della richiesta può non avere
 * affatto il campo, mentre la riga letta dal database ce l'ha sempre (a `null`).
 */
export function intervallo(avviso: {
    numero_min?: number | null;
    numero_max?: number | null;
}): { min: number; max: number } {
    return {
        min: avviso.numero_min ?? MIN_PREDEFINITO,
        max: avviso.numero_max ?? MAX_PREDEFINITO,
    };
}

export type EsitoConfigurazione =
    | { ok: true }
    | { ok: false; codice: 'ETICHETTA_MANCANTE' | 'NUMERO_INTERVALLO_NON_VALIDO' };

/**
 * LA CONFIGURAZIONE DEL CONTATORE, COME LA MANDA IL MODULO DELLA SEGRETERIA.
 *
 * Restituisce un codice e non un messaggio: la stessa funzione serve al POST, al
 * PUT e ai test, e nessuno dei tre scrive la frase allo stesso modo. Il testo per
 * la persona lo mette il chiamante.
 *
 * ── A CONTATORE SPENTO NON SI CONTROLLA NIENTE ──────────────────────────────
 *
 * Se `chiediNumero` è falso i tre campi sono rumore: l'interfaccia li lascia
 * riempiti quando la segreteria accende e poi rispegne l'interruttore, e
 * rifiutare il salvataggio per un'etichetta rimasta in un campo NASCOSTO sarebbe
 * un 400 che parla di qualcosa che l'operatore non vede sullo schermo. Non li si
 * valida e non li si archivia: il posto in cui vengono azzerati è la rotta.
 *
 * ── L'ETICHETTA VUOTA NON È UN'ETICHETTA ────────────────────────────────────
 *
 * `''` e `'   '` sono la stessa cosa di un campo mai compilato. Senza il `trim`,
 * uno spazio battuto per sbaglio produrrebbe una domanda invisibile sopra un
 * campo numerico, e il genitore leggerebbe un riquadro senza sapere che cosa gli
 * si sta chiedendo. Chi non vuole scrivere la domanda ha
 * `ETICHETTA_NUMERO_PREDEFINITA`, che la rotta applica al posto del vuoto.
 */
export function validaConfigurazione(input: {
    chiediNumero: boolean | null | undefined;
    etichetta: string | null | undefined;
    min: number | null | undefined;
    max: number | null | undefined;
}): EsitoConfigurazione {
    if (!input.chiediNumero) return { ok: true };

    if (input.etichetta === null || input.etichetta === undefined || input.etichetta.trim() === '') {
        return { ok: false, codice: 'ETICHETTA_MANCANTE' };
    }

    const { min, max } = intervallo({ numero_min: input.min, numero_max: input.max });
    // ⚠️ GEMELLO della seconda metà di `CHECK (numero_min >= 1 AND numero_max >=
    // numero_min AND numero_max <= 999)` del cantiere A2. I due estremi da soli
    // passano già da `zNumeroPartecipanti`; quello che uno schema zod non può
    // vedere è il RAPPORTO fra i due, ed è l'unico che produrrebbe un 23514 →
    // 500 invece di un 400 leggibile: `min: 10, max: 4` è un modulo che nessuna
    // famiglia può compilare, e il messaggio che arriverebbe dal database
    // nominerebbe il vincolo, non il campo.
    if (min > max) return { ok: false, codice: 'NUMERO_INTERVALLO_NON_VALIDO' };

    return { ok: true };
}
