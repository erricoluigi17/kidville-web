// Le risposte d'errore degli allegati — con un CODICE, mai col testo del fornitore.
//
// PERCHÉ ESISTE (collaudo del 2026-07-31, S31).
//
// `avvisi/upload` e `tasks/upload` rigiravano al client il messaggio dello Storage tale e
// quale: `500 {"error":"mime type text/plain is not supported"}`. Il gate MIME
// (`./mime.ts`) chiude i casi PREVISTI prima che il file parta, ma la via dell'errore
// IMPREVISTO restava aperta — il bucket che stringe la sua lista, una quota, un guasto di
// rete — e da lì usciva il testo grezzo del fornitore: inglese, con il nome di un vincolo
// interno, davanti a chi lavora in segreteria.
//
// Le due metà non si scambiano fra loro:
//  · al CLIENT una frase comprensibile con un `codice` che il catalogo sa tradurre
//    (`messaggioErrore`, `src/lib/ui/esito-fetch.ts`);
//  · al LOG il corpo dell'errore del fornitore INTERO (AGENTS §3). Loggare uno status
//    senza il corpo è il bug, non un dettaglio: «403» non dice niente, «403 the domain is
//    not verified» dice tutto. Il log è l'unico posto in cui quel testo può esistere.
//
// Sta in un modulo suo e non dentro le due route perché una risposta d'errore scritta due
// volte diverge alla prima modifica: è la stessa ragione per cui il gate MIME è uno solo.

import { NextResponse } from 'next/server'

/**
 * 500 — il caricamento non è riuscito, e il perché sta nel log.
 *
 * Il testo è quello del catalogo italiano (`erroreAllegatoNonCaricato`): al client che
 * traduce arriva comunque il `codice`, a un client vecchio resta una frase leggibile.
 */
export function rispostaAllegatoNonCaricato(): NextResponse {
    return NextResponse.json(
        {
            error: 'Non è stato possibile caricare il file: riprova fra qualche istante',
            codice: 'ALLEGATO_NON_CARICATO',
        },
        { status: 500 },
    )
}

/**
 * La rimozione di un allegato appena caricato non si può fare (sigillo assente, scaduto,
 * di un altro utente o di un altro file) — oppure non è riuscita.
 *
 * Un solo codice per i due casi, ed è deliberato: all'operatore dicono la stessa cosa («il
 * file resta dov'è»), e la differenza — che serve a chi diagnostica — vive nel log, dove
 * c'è il motivo esatto. Due codici avrebbero significato due voci di catalogo per
 * distinguere qualcosa che l'utente non può usare in nessun modo.
 */
export function rispostaAllegatoNonRimosso(status: number): NextResponse {
    return NextResponse.json(
        {
            error: 'Non è stato possibile rimuovere il file appena caricato',
            codice: 'ALLEGATO_NON_RIMOSSO',
        },
        { status },
    )
}
