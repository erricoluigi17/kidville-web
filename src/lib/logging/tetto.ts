/**
 * IL TETTO DI TEMPO SU UNA `fetch`, IN UN POSTO SOLO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO FILE, e non due copie della stessa idea.
 *
 * `fetch` non ha nessun timeout di suo. È stato MISURATO, non dedotto: un server che ACCETTA
 * la connessione e non risponde mai tiene appesa la chiamata **150 secondi senza eccezione né
 * timeout**, e sarebbe rimasta appesa finché la piattaforma non taglia la funzione. L'operatore
 * che ha premuto «invia» aspetta senza limite e senza errore; la lambda resta occupata.
 *
 * Il 2026-08-03, di mattina, la correzione è stata scritta dentro `external.ts` — i 13 provider
 * esterni. Il suo GEMELLO non l'ha ricevuta: `supabase-fetch.ts`, stesso modulo, stessa
 * primitiva, citato da `external.ts` stesso, e da cui passano **tutte** le chiamate PostgREST e
 * auth dell'applicazione. Un Supabase che accetta e tace appendeva la route esattamente come
 * faceva un provider — col gate verde, perché la regola viveva su una strada sola e nessun test
 * guardava l'altra.
 *
 * È la lezione già pagata in questo repo su un altro incidente (il PUT degli avvisi senza gate
 * di sede, 1 OTP su 4 senza tetto): **una regola valida per due strade deve vivere in un posto
 * solo**. Questo file è quel posto, e
 * `__tests__/lib/logging-tetto.test.ts` è il lock che impedisce che torni a essere due.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COSA STA QUI E COSA NO. Qui c'è il MECCANISMO: come si attacca una scadenza a un `init`, come
 * si riconosce che è scattata, come si rietichetta perché sia ritrovabile. I NUMERI no: quanto
 * aspetta un provider (`external.ts`) o un'area di Supabase (`supabase-fetch.ts`) è una
 * decisione che vive accanto alla sua ragione, e le due tabelle non hanno niente in comune se
 * non il fatto di essere tabelle.
 *
 * REGOLA D'ORO, la stessa di tutto `src/lib/logging/**`: NIENTE qui dentro lancia. Una rete di
 * sicurezza che abbatte l'app è peggio del guasto da cui protegge (AGENTS, regola 9).
 */

/**
 * Un tetto SANO: un numero di millisecondi positivo e finito. Altrimenti si ricade sul ripiego.
 *
 * Un valore assurdo NON diventa «nessun tetto»: `0` e i negativi interromperebbero la chiamata
 * prima di farla, `NaN` e `Infinity` danno un `AbortSignal.timeout` che non scatta mai — cioè
 * di nuovo, per una strada diversa, il difetto da cui tutto questo nasce. Si torna al valore
 * dichiarato, che è il verso giusto in cui sbagliare.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL `massimo`, e l'unica cosa che vincola — perché le due che potrebbe vincolare non sono la
 * stessa cosa.
 *
 * Un tetto di mezz'ora è funzionalmente NESSUN tetto: a tagliare tornerebbe la piattaforma, e
 * il difetto rientrerebbe intero. Fino al 2026-08-03 il limite superiore esisteva soltanto nei
 * test delle due tabelle, quindi copriva le TABELLE e non il CHIAMANTE: `tettoMs('resend',
 * 3_600_000)` restituiva 3.600.000 e nessun test diventava rosso — c'era perfino un test che
 * nel NOME dichiarava l'invariante («nemmeno un chiamante può chiedere un tetto smisurato») e
 * ne asseriva solo l'altra metà. Il `massimo` è quell'invariante scritta nel codice.
 *
 * VINCOLA IL VALORE RICHIESTO, NON IL RIPIEGO, e la distinzione è il punto:
 *
 *  · il RICHIESTO arriva da un chiamante, si valuta a ogni chiamata e non lo rilegge nessuno:
 *    va tosato qui, dove passa;
 *  · il RIPIEGO è il valore della TABELLA (`TETTI_MS_PROVIDER`, `TETTI_MS_AREA`), e su quello
 *    l'ancoraggio assoluto è un TEST che lo misura. Tosarlo anche qui renderebbe quel test
 *    verde per costruzione: si potrebbe scrivere `['web-push', 600_000]` in tabella e nessuno
 *    se ne accorgerebbe più, perché la funzione restituirebbe comunque un numero ragionevole.
 *    Sarebbe una rete che nasconde il buco invece di segnalarlo.
 *
 * Un `massimo` assurdo (0, negativo, `NaN`) si ignora, come ogni altro numero assurdo di questo
 * file: meglio nessun limite superiore che un tetto azzerato su tutte le chiamate.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
export function tettoSano(richiesto: unknown, ripiego: number, massimo?: number): number {
    try {
        if (typeof richiesto !== 'number' || !Number.isFinite(richiesto) || richiesto <= 0) {
            return ripiego;
        }
        return typeof massimo === 'number' && Number.isFinite(massimo) && massimo > 0
            ? Math.min(richiesto, massimo)
            : richiesto;
    } catch {
        return ripiego;
    }
}

/**
 * Un segnale che scade da solo, per chi NON passa da un `RequestInit`.
 *
 * ─── PERCHÉ ESISTE, invece di scrivere `AbortSignal.timeout` sul posto ──────
 * `conTetto` qui sotto serve chi chiama `fetch`: prende un `init` e ne restituisce
 * uno col segnale attaccato. Ma non tutto quel che va limitato è una `fetch` con un
 * `init` in mano — il builder di PostgREST, per esempio, vuole il segnale nudo
 * (`.abortSignal(s)`), e il rate-limiter condiviso passa di lì.
 *
 * Senza questa funzione quel chiamante avrebbe due sole strade, e sono entrambe la
 * stessa cosa che questo file esiste per impedire: scriversi `AbortSignal.timeout`
 * per conto suo, oppure assemblare a mano un `AbortController` con un `setTimeout`
 * che lo interrompe. Il lock `__tests__/lib/logging-tetto.test.ts` le riconosce
 * entrambe e le respinge, ed è successo davvero — la prima stesura del tetto
 * condiviso le aveva scritte tutte e due.
 *
 * FAIL-OPEN come `conTetto`: se `AbortSignal.timeout` non esiste o lancia (WebView
 * vecchia, polyfill incompleto) si restituisce `undefined`. Il chiamante resta senza
 * segnale — cioè senza QUESTA difesa — e deve avere la propria: chi usa questa
 * funzione non può dedurre dal segnale che il tempo sia governato.
 */
export function segnaleConTetto(ms: number): AbortSignal | undefined {
    try {
        return AbortSignal.timeout(ms);
    } catch {
        return undefined;
    }
}

/**
 * L'`init` del chiamante con il tetto attaccato — se non ne ha già uno suo.
 *
 * IL SIGNAL DEL CHIAMANTE VINCE, e non è una cortesia: chi passa un signal sta governando la
 * vita della chiamata (l'annulla, la lega alla richiesta), e sovrapporgli un secondo motivo di
 * interruzione renderebbe il suo `abort()` indistinguibile dal nostro. La condizione è sulla
 * truthiness e non su `!== undefined`: un `signal: null` esplicito significa «nessuno», e
 * nessuno è proprio il caso in cui il tetto deve esserci.
 *
 * SI GUARDA ANCHE L'`input`, e serve. Quando è una `Request` porta SEMPRE un signal suo, e la
 * specifica di `fetch` dice che se `init` ne contiene uno quello della `Request` non viene più
 * usato: passargli il nostro disarmerebbe in silenzio un annullamento che il chiamante crede
 * ancora attivo. Nessuna delle due strade passa `Request` oggi (supabase-js e i provider
 * chiamano con una stringa), ma il costo del controllo è nullo e il modo di sbagliare senza
 * sarebbe muto.
 *
 * FAIL-OPEN: se `AbortSignal.timeout` non esiste o lancia (un runtime vecchio, un polyfill
 * incompleto), si restituisce l'`init` così com'era. Si perde il tetto, non la chiamata.
 */
export function conTetto(
    input: unknown,
    init: RequestInit | undefined,
    ms: number,
): RequestInit | undefined {
    try {
        if (ilChiamanteGoverna(input, init)) return init;
        return { ...init, signal: AbortSignal.timeout(ms) };
    } catch {
        return init;
    }
}

function ilChiamanteGoverna(input: unknown, init: RequestInit | undefined): boolean {
    try {
        if (init?.signal) return true;
        const suo = (input as { signal?: unknown } | null | undefined)?.signal;
        return suo !== undefined && suo !== null;
    } catch {
        // Un `input` illeggibile (un Proxy ostile, un mock): non gli si mettono le mani addosso.
        return true;
    }
}

/**
 * L'interruzione è arrivata da una SCADENZA?
 *
 * `TimeoutError` è il nome che la specifica dà al motivo di `AbortSignal.timeout` (misurato su
 * Node 24: `name: 'TimeoutError'`, `code: 23`). Un `AbortError` — cioè un `abort()` chiesto a
 * mano da chi ha passato il proprio signal — NON è un timeout: è un annullamento voluto, e
 * spacciarlo per scadenza manderebbe a cercare un bersaglio lento che non c'è.
 */
export function eTimeout(err: unknown): boolean {
    try {
        return (err as { name?: unknown } | null | undefined)?.name === 'TimeoutError';
    } catch {
        return false;
    }
}

/**
 * L'errore che si LOGGA al posto del DOMException di piattaforma.
 *
 * UN TIMEOUT NON È UNA RETE GIÙ, e per questo ha un codice suo: «il bersaglio non risponde» si
 * ripara alzando il tetto o chiamando il fornitore, «il bersaglio non si raggiunge» si ripara
 * sul DNS o sul firewall. Con un codice solo, in `app_log` i due guasti sarebbero
 * indistinguibili — cioè si tornerebbe a un numero che non dice nulla, che è il vizio che
 * l'intero `src/lib/logging/**` esiste per non ripetere.
 *
 * Tre cose, tutte e tre per essere ritrovabili:
 *  · `code: 'timeout'` → colonna `app_log.codice`, cioè `where codice = 'timeout'` conta i
 *    bersagli che non rispondono. Il `23` originale (il codice legacy di DOMException) lì
 *    dentro sarebbe indistinguibile da uno status HTTP;
 *  · un NOME proprio, perché `get_runtime_errors` di Vercel raggruppa per *error name*: le
 *    scadenze stanno nel loro secchio, separate dai rifiuti HTTP e dai bug veri del codice;
 *  · il tetto DENTRO il messaggio, in millisecondi: senza il numero non si distingue «è morto»
 *    da «il tetto è troppo stretto», che sono due riparazioni opposte.
 *
 * `cause` conserva il DOMException originale — `descriviErrore` lo segue di un livello, quindi
 * sulla riga resta anche il motivo di piattaforma, e non si è buttato via niente. Lo stack è
 * catturato QUI, dentro la catena che parte dalla route: dice CHI stava chiamando.
 */
export function erroreTimeout(
    nome: string,
    soggetto: string,
    tetto: number,
    causa: unknown,
): Error {
    const err = new Error(`nessuna risposta ${soggetto} entro il tetto di ${tetto} ms`, { cause: causa });
    err.name = nome;
    Object.assign(err, { code: 'timeout' });
    return err;
}
