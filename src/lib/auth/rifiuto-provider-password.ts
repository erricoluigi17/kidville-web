/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Perché GoTrue ha detto di no — e perché la risposta «scegline una più lunga»
 * era quella sbagliata.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Le nostre regole (`regole-password.ts`) giudicano quattro cose: lunghezza,
 * lettera+cifra, spazi ai bordi, diversa dalla precedente. Quando tutte e quattro
 * passano, la password parte verso il provider — e il provider può ancora dire di
 * no, per motivi che noi non abbiamo modo di prevedere.
 *
 * Fino al 2026-09-04 quel «no» era uno solo: qualunque 4xx diventava
 * `PASSWORD_RIFIUTATA`, la cui frase consiglia «più lunga e con almeno una lettera
 * e una cifra». Misurato in produzione lo stesso giorno: **30 rifiuti su 20 utenti
 * distinti**, 47 su 29 il giorno prima, tutti con lo stesso codice —
 * `weak_password` — e tutti mandati a correggere requisiti che erano già
 * soddisfatti, con i tre criteri della schermata verdi sotto gli occhi.
 * Un rifiuto che indica il rimedio sbagliato manda a sbattere due volte.
 *
 * ─── SI LEGGE IL CODICE, NON IL MESSAGGIO ─────────────────────────────────────
 *
 * `message` di GoTrue è prosa inglese: non esce dall'interfaccia (è precisamente
 * ciò che il catalogo dei codici è servito a togliere) e non si usa nemmeno per
 * decidere, perché una prosa può cambiare fra due versioni del provider senza che
 * un solo test diventi rosso. `code`/`error_code` invece è un enumerato, ed è già
 * dichiarato in chiaro fra le `CHIAVI_IN_CHIARO` di `redact.ts`: è la sola parte
 * dell'errore che si può guardare, e la sola che si può registrare.
 *
 * ─── PERCHÉ UN MODULO E NON DUE `if` ──────────────────────────────────────────
 *
 * Le route che scrivono una password scelta dall'utente sono due
 * (`account/password` e `parent/onboarding`), e la stessa domanda posta in due
 * posti diverge: è già successo in questo repo, e si vede come due utenti che
 * ricevono due messaggi diversi per lo stesso identico rifiuto.
 */

/**
 * Cosa fare del rifiuto, dal punto di vista di chi sta scegliendo la password.
 *
 * · `password-nota` .......... è una password vera ma già rubata altrove: la forma
 *                              va bene, serve una parola meno comune;
 * · `password-non-accettata` . il provider l'ha respinta per un motivo che non
 *                              conosciamo: si può solo sceglierne un'altra;
 * · `guasto` ................. non è la password: è il servizio. La precedente
 *                              resta valida e il rimedio è riprovare.
 */
export type RifiutoProvider = 'password-nota' | 'password-non-accettata' | 'guasto'

/** Il codice `weak_password` di GoTrue: password presente in liste di violazione. */
const CODICE_PASSWORD_NOTA = 'weak_password'

/**
 * Un codice del provider è un enumerato: minuscolo, corto, senza spazi.
 *
 * Il controllo non è pedanteria. `error_code` esce IN CHIARO nei log, e se un
 * giorno il provider ci infilasse il messaggio (o un dato dell'utente) al posto
 * dell'enumerato, quella stringa finirebbe registrata senza passare da nessuna
 * redazione. Si accetta solo ciò che ha la forma di un codice.
 */
const FORMA_CODICE = /^[a-z][a-z0-9_]{0,39}$/

function codiceDi(errore: unknown): string | undefined {
    if (typeof errore !== 'object' || errore === null) return undefined
    const e = errore as { code?: unknown; error_code?: unknown }
    for (const grezzo of [e.code, e.error_code]) {
        if (typeof grezzo === 'string' && FORMA_CODICE.test(grezzo)) return grezzo
    }
    return undefined
}

function statoDi(errore: unknown): number | undefined {
    if (typeof errore !== 'object' || errore === null) return undefined
    const stato = (errore as { status?: unknown }).status
    // `'422'` come stringa NON è 422: un confronto lasco qui classificherebbe come
    // rifiuto dell'utente un oggetto che non viene dal provider.
    return typeof stato === 'number' ? stato : undefined
}

/**
 * Classifica il rifiuto del provider. Non lancia mai, e su qualunque forma
 * imprevista risponde `'guasto'`: sbagliare verso «è colpa del servizio» manda a
 * riprovare, sbagliare verso «è colpa tua» manda a rifare un lavoro che era giusto.
 */
export function classificaRifiutoPassword(errore: unknown): RifiutoProvider {
    const stato = statoDi(errore)
    if (stato === undefined || stato < 400 || stato >= 500) return 'guasto'
    return codiceDi(errore) === CODICE_PASSWORD_NOTA ? 'password-nota' : 'password-non-accettata'
}

/**
 * Il codice del provider da mettere nel log — o `undefined` se non ne ha uno con
 * la forma di un codice. Serve a distinguere a posteriori i rifiuti fra loro:
 * senza, le trenta occorrenze di una giornata restano una massa indistinta.
 */
export function codiceProviderPerLog(errore: unknown): string | undefined {
    return codiceDi(errore)
}
