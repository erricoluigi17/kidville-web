import { NextResponse } from 'next/server'

/**
 * IL TOKEN DEL LINK PUBBLICO DI UN MODELLO — validato PRIMA di toccare il database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE (collaudo del 2026-08-02, terza tornata · F2)
 *
 * Misurato sul server vivo:
 *   POST /api/public/forms/non-un-uuid/submit        → 500 {"error":"Errore interno"}
 *   POST /api/public/forms/<uuid-inesistente>/submit → 404  (corretto)
 *
 * La causa era scritta, in italiano, in un commento sopra lo schema del token:
 * «Il token pubblico è una stringa opaca (usata su form_models.public_token), NON un uuid».
 * Da lì `z.string().min(1)`, cioè: passa qualunque cosa. Solo che quel commento diceva il
 * falso — nella baseline la colonna è `public_token uuid`, e chi la valorizza è
 * `randomUUID()` in `admin/form-models/publish`. Il token storto arrivava intatto fino a
 * `.eq('public_token', …)` e Postgres rispondeva `22P02`; la route leggeva quell'errore per
 * quello che sembrava — un guasto di lettura — e rispondeva 500.
 *
 * È il difetto più difficile da vedere rileggendo il codice: nessuna riga è sbagliata. Lo è
 * un'affermazione in prosa che nessuno ha più verificato contro lo schema.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ 404 E NON 400
 *
 * Perché «malformato» e «inesistente» non devono distinguersi. Il token È la credenziale
 * che apre `/m/{token}` senza account: due risposte diverse dicono a chi prova a indovinare
 * quando ha imbroccato almeno la FORMA giusta, cioè regalano metà del lavoro. La stessa
 * scelta è già scritta in `requireParentOfStudent`, che su un `studentId` non-uuid risponde
 * 404 e non 400 («un id che non è un uuid non è un alunno»): qui vale identica, e per la
 * stessa ragione.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ NON PASSA PIÙ DA `parseData`
 *
 * Due motivi. Il primo è il numero: `parseData` risponde 400 con l'elenco dei problemi di
 * zod, che qui è esattamente ciò che non si vuole dire. Il secondo è che `parseData`
 * DEPOSITA il valore nel contesto di log, e un uuid attraversa in chiaro la lista bianca di
 * `redact` — cioè il token finiva scritto in `app_log`. Un token è una capability: chi legge
 * il log non deve poter aprire il modulo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ IN UN MODULO SUO, PER DUE SOLE ROUTE
 *
 * Perché le route sono due — `submit` e `upload` — e leggono lo stesso token dalla stessa
 * colonna. `upload` rispondeva già 404 al token storto, ma per caso e non per scelta:
 * buttava via l'`error` di PostgREST (`const { data: model } = …`) e si ritrovava `model` a
 * `null`. Una regola valida per due strade e applicata a una sola è la forma di difetto che
 * questo ciclo ha già corretto quattro volte — POST/PUT degli avvisi, tasks/avvisi, uno dei
 * quattro OTP, i tipi degli allegati pubblici. Qui la regola nasce già in un posto solo.
 */

/** Formato canonico 8-4-4-4-12: è ciò che `randomUUID()` produce e ciò che la colonna accetta. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * L'unica risposta che le route pubbliche danno su un token che non apre niente.
 *
 * Una sola funzione per i tre casi — malformato, inesistente, non pubblicato — perché la
 * loro indistinguibilità è il punto: se il testo divergesse anche di una virgola, la
 * differenza tornerebbe misurabile da fuori.
 */
export function rispostaModuloNonTrovato(): NextResponse {
    // Il `codice` accanto alla prosa: questo 404 lo legge una FAMIGLIA, dal telefono, fuori
    // da qualunque sessione — cioè il pubblico per cui l'interfaccia può benissimo essere in
    // inglese. La frase italiana resta per i client vecchi, la traduzione la fa il catalogo
    // (`messaggioErrore`, `src/lib/ui/esito-fetch.ts`).
    // Sul filo viaggia la CHIAVE di `CODICI_ERRORE` (`MODULO_NON_TROVATO`), non il suo
    // valore (`erroreModuloNonTrovato`, che è la chiave di CATALOGO): `testoDelCodice` fa
    // `CODICI_ERRORE[codice]`, quindi col valore la ricerca torna `undefined` e il client
    // ricade in silenzio sulla prosa italiana — cioè il difetto che i codici esistono per
    // chiudere, con l'aria di essere chiuso. Scritto sbagliato la prima volta il 2026-08-02,
    // e nessun lock l'ha visto: `errori-con-codice` verifica che un `codice` CI SIA, non che
    // si risolva. Lo verifica il test di rotta, che passa da `messaggioErrore`.
    return NextResponse.json(
        { error: 'Modulo non trovato o non pubblicato', codice: 'MODULO_NON_TROVATO' },
        { status: 404 },
    )
}

export type TokenPubblico = { token: string } | { response: NextResponse }

/**
 * Il token del path, se ha la forma di un uuid; altrimenti la risposta 404 già pronta.
 *
 * Uso (PRIMA di qualunque query):
 * ```ts
 * const tk = tokenPubblico(rawParams.token)
 * if ('response' in tk) return tk.response
 * ```
 */
export function tokenPubblico(grezzo: unknown): TokenPubblico {
    if (typeof grezzo === 'string' && UUID.test(grezzo)) return { token: grezzo }
    return { response: rispostaModuloNonTrovato() }
}
