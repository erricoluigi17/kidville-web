import { logEvento, type Livello, type Valore } from './logger';
import { redigiPath } from './redact';
import { sanificaMessaggio } from './serialize';

/**
 * Le chiamate ai provider ESTERNI (Resend, FCM, web-push, Aruba/SDI, SIDI).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * L'INVARIANTE, ed è la ragione per cui questo modulo esiste:
 *
 *   SU `!res.ok` IL CORPO DELLA RISPOSTA SI LEGGE, SI LOGGA E SI PROPAGA.
 *   MAI lo status da solo.
 *
 * Non è una buona pratica generica: è il guasto vero di questo progetto. Per MESI nessuna
 * email di credenziali è arrivata a un genitore, perché Resend rispondeva `403` e il codice
 * registrava soltanto il numero — mentre il corpo diceva, in chiaro, «the kidville.it domain
 * is not verified». `403` non dice nulla e nessun test era rosso; `403 "the domain is not
 * verified"` avrebbe chiuso il caso in cinque minuti. Lo stesso vizio è ancora in
 * `push/native-push.ts`, che il corpo FCM lo legge e poi lo butta (`fcm_http_${status}`).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * DOVE FINISCE IL CORPO, e perché NON in un campo `corpo`.
 *
 * Il corpo diventa il MESSAGGIO dell'errore che si passa a `logEvento`, non un campo dei
 * `campi`. `redact()` è a lista bianca PER CHIAVE e `corpo` in lista non c'è: nella riga che
 * va in `app_log` — l'unico canale che dura 30 giorni e si interroga in SQL — uscirebbe come
 * `[redatto:str/180]`, cioè illeggibile esattamente là dove serve. Passato invece come
 * errore, `descriviErrore()` lo normalizza nei campi dedicati: `message` → colonna
 * `app_log.messaggio` (in chiaro, e sanificato da `sanificaMessaggio`, che maschera email e
 * codici fiscali eventualmente presenti nel corpo del provider), `code` → colonna
 * `app_log.codice`, interrogabile. È la stessa scelta, con le stesse ragioni, di
 * `erroreDalCorpo()` in `supabase-fetch.ts`.
 *
 * IL SUCCESSO SI LOGGA (AGENTS, regola 5). Con i soli errori, «nessun log» non distingue
 * «tutto ok» da «non è mai partito niente» — ed è precisamente l'ambiguità che ha tenuto
 * nascosto per mesi il guasto delle email. Chi passa un `evento` fra quelli critici
 * (`email`, `push`, …: vedi `EVENTI_PERSISTITI`) ottiene il battito anche in tabella.
 *
 * Regola d'oro del modulo, come per tutto `src/lib/logging/**`: NON LANCIA MAI. Nemmeno su
 * rete giù, nemmeno su una risposta illeggibile. Un guasto dell'osservabilità non può
 * diventare un guasto del prodotto: si restituisce un esito che il chiamante può leggere.
 */

/** Quanto corpo d'errore ci si porta dietro (nell'esito e nel log). */
const CORPO_MAX = 1_000;

/**
 * Tetto REALE, in byte, di quanto corpo si LEGGE dallo stream. Non è la stessa cosa di
 * `CORPO_MAX`: un `await res.text()` seguito da uno `.slice()` bufferizzerebbe comunque
 * TUTTA la risposta in RAM prima di poterla tagliare, e la pagina HTML che un proxy a monte
 * sputa al posto del provider non ha nessun obbligo di essere piccola. Si legge a pezzi e si
 * smette: il limite è quello scritto qui, non quello che dichiara chi risponde.
 */
const CORPO_LETTURA_MAX = 64_000;

export interface EsitoEsterno {
    ok: boolean;
    /** Lo status HTTP. `0` quando una risposta non c'è stata affatto (rete giù, DNS, TLS). */
    stato: number;
    /**
     * Il corpo dell'errore — o il messaggio dell'eccezione di rete. SEMPRE valorizzato quando
     * `ok` è falso (salvo che il provider abbia risposto davvero a corpo vuoto), SEMPRE vuoto
     * quando `ok` è vero: lì il corpo non lo tocchiamo (vedi `res`).
     */
    corpo: string;
    /**
     * La `Response`, SOLO quando `ok` è vero, e con il corpo INTATTO: lo stream si consuma una
     * volta sola, quindi chi chiama deve poter fare il suo `res.json()`. Su `!ok` non c'è, e
     * non è una dimenticanza: il corpo l'abbiamo già consumato noi per poterlo loggare, e
     * restituire una Response svuotata sarebbe una trappola.
     */
    res?: Response;
}

export interface OpzioniEsterne {
    /**
     * L'evento di dominio della riga. Default `esterno`.
     *
     * Serve a una cosa sola, ma è quella che rende il log utile: `email` e `push` sono in
     * `EVENTI_PERSISTITI`, quindi con il nome giusto anche il SUCCESSO finisce in tabella
     * (regola 5) e una sola query — `where evento = 'email'` — restituisce sia gli invii
     * riusciti sia quelli rifiutati. Con un `esterno` cablato qui dentro, il chiamante
     * dovrebbe emettere una SECONDA riga per il proprio evento: due righe per una chiamata,
     * su un canale dove «un logger loquace ACCECA» (vedi `logger.ts`).
     */
    evento?: string;
    /**
     * Metadati aggiuntivi. Attenzione ai NOMI: `redact()` è a lista bianca per chiave, quindi
     * in TABELLA sopravvivono in chiaro solo le chiavi note (`operazione`, `piattaforma`,
     * `canale`, `esito`, `provider`, `stato`…) più numeri, booleani, uuid e date. Una chiave
     * inventata finisce in `app_log` come `[redatto:str/N]`.
     */
    campi?: Record<string, Valore>;
    /**
     * La gravità di un `!ok`. Default: `error`.
     *
     * Esiste per un caso solo, ma senza questa valvola quel caso AVVELENA il canale degli
     * errori: un token FCM di un'app disinstallata risponde `404`/`UNREGISTERED`. Non è un
     * guasto, è la vita normale di una scuola — e a livello `error` emetterebbe un Error
     * nativo su console per ogni genitore che cancella l'app, inquinando il raggruppamento di
     * `get_runtime_errors` e la colonna `livello` di chi in SQL cerca «gli errori di oggi».
     * La riga resta (a `info`, e in tabella se l'evento è critico): si conta, non allarma.
     */
    gravita?: (stato: number, corpo: string) => Livello;
}

/**
 * `fetch` verso un provider esterno, osservato. `provider` è il nome breve che finisce sulla
 * riga (`resend`, `fcm`, `aruba`): è in lista bianca, quindi si legge in chiaro anche in
 * tabella.
 */
export async function externalFetch(
    provider: string,
    url: string,
    init?: RequestInit,
    opzioni?: OpzioniEsterne,
): Promise<EsitoEsterno> {
    const t0 = Date.now();

    let res: Response;
    try {
        // `globalThis.fetch` risolto alla CHIAMATA, non al caricamento del modulo: Next 16
        // patcha il fetch globale per il proprio caching, e non c'è garanzia che l'abbia già
        // fatto quando questo modulo viene importato.
        res = await globalThis.fetch(url, init);
    } catch (err) {
        // Rete giù, DNS, TLS, timeout. NON si rilancia — è il contratto di questo modulo:
        // il chiamante (l'invio di un'email, una push) deve poter degradare, non morire.
        // Si passa l'errore ORIGINALE al logger: ha lo stack vero, che dice CHI stava
        // chiamando il provider.
        const ms = Date.now() - t0;
        emetti(provider, url, ms, undefined, 'error', opzioni, err);
        return { ok: false, stato: 0, corpo: messaggioDi(err) };
    }

    const ms = Date.now() - t0;
    const stato = statoDi(res);

    if (ok(res)) {
        // Il corpo NON si tocca: lo stream si consuma una volta sola e il `res.json()` è del
        // chiamante. Il battito di successo è questa riga.
        emetti(provider, url, ms, stato, 'info', opzioni, undefined);
        return { ok: true, stato, corpo: '', res };
    }

    const corpo = await leggiCorpo(res);
    emetti(provider, url, ms, stato, livelloDi(stato, corpo, opzioni), opzioni, erroreHttp(stato, corpo));
    return { ok: false, stato, corpo };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Emissione. Niente qui dentro può lanciare.
 * ──────────────────────────────────────────────────────────────────────────── */

function emetti(
    provider: string,
    url: string,
    ms: number,
    stato: number | undefined,
    livello: Livello,
    opzioni: OpzioniEsterne | undefined,
    err: unknown,
): void {
    try {
        logEvento(nomeEvento(opzioni), livello, campiDi(provider, url, ms, stato, opzioni), err);
    } catch {
        // `logEvento` è già fail-open per costruzione; questo try è la rete sotto la rete.
        // Si perde il log, non l'email.
    }
}

function nomeEvento(opzioni: OpzioniEsterne | undefined): string {
    const e = opzioni?.evento;
    return typeof e === 'string' && e !== '' ? e : 'esterno';
}

/**
 * I campi della riga. L'ordine è il budget (Vercel taglia dalla CODA): prima `operazione`,
 * che è ciò che dice DI COSA si parla, poi i fatti della risposta.
 *
 * `provider`, `ms` e `stato` sono nostri e vincono su quelli del chiamante: sono la verità
 * misurata sulla risposta, non un'opinione. `stato` si OMETTE quando la risposta non c'è
 * stata: `stato: 0` finirebbe nella colonna `app_log.stato_http`, dove `where stato_http >=
 * 500` conta i guasti — e uno zero lì dentro è uno status HTTP che non esiste.
 */
function campiDi(
    provider: string,
    url: string,
    ms: number,
    stato: number | undefined,
    opzioni: OpzioniEsterne | undefined,
): Record<string, Valore> {
    try {
        return {
            operazione: operazioneDi(url),
            ...opzioni?.campi,
            provider,
            ms,
            stato,
        };
    } catch {
        // Uno spread su un Proxy ostile: si perdono i campi del chiamante, non la riga.
        return { provider, ms, stato };
    }
}

/**
 * Il nome di default dell'operazione: il PATTERN del path del provider. Non è cosmesi — è la
 * colonna `app_log.messaggio` di una riga di SUCCESSO: `testoEvento()` prende il primo fra
 * `msg`, `esito`, `operazione`, `stato`, e senza `operazione` il messaggio di ogni email
 * riuscita sarebbe la stringa «200». Chi chiama può (e dovrebbe) passarne uno parlante
 * (`sendEmail`, `messages:send`): questo è il ripiego perché nessuno resti muto.
 *
 * `redigiPath` + `sanificaMessaggio` come in `supabase-fetch.ts`: `operazione` è in lista
 * bianca, quindi `redact()` la lascia in chiaro E non la sanifica: se un id o un indirizzo
 * finisse nel path del provider, quello sarebbe il canale su cui nessun altro sta guardando.
 */
function operazioneDi(url: string): string {
    try {
        return sanificaMessaggio(redigiPath(new URL(url).pathname));
    } catch {
        return '?';
    }
}

/** Default `error`; il chiamante può declassare (vedi `gravita`). Un predicato che lancia non decide. */
function livelloDi(stato: number, corpo: string, opzioni: OpzioniEsterne | undefined): Livello {
    try {
        return opzioni?.gravita?.(stato, corpo) ?? 'error';
    } catch {
        return 'error';
    }
}

/**
 * Il corpo del provider diventa un Error VERO, e non un oggetto `{ message, code }` nudo, per
 * una ragione in più rispetto alla normalizzazione (che darebbero entrambi): `new Error()`
 * cattura lo STACK QUI, cioè dentro la catena di chiamate che parte dalla route. È ciò che
 * dice QUALE dei nostri percorsi ha parlato col provider — informazione che un `403` non ha
 * mai avuto, e che nella colonna `app_log.stack` resta.
 *
 * Un NOME proprio perché `get_runtime_errors` di Vercel raggruppa per *error name*: gli errori
 * dei provider stanno nel loro secchio invece di mescolarsi ai bug veri del codice.
 *
 * `code` è lo status: finisce in `app_log.codice` e si interroga (`where codice = '403'`).
 * L'Error grezzo non arriva mai su console — `logEvento` ne emette una COPIA sanificata.
 */
function erroreHttp(stato: number, corpo: string): Error {
    const err = new Error(corpo === '' ? `HTTP ${stato}` : corpo);
    err.name = 'ExternalHttpError';
    Object.assign(err, { code: String(stato) });
    return err;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il corpo.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Legge il corpo con un limite VERO, a pezzi (vedi `CORPO_LETTURA_MAX`).
 *
 * Niente `clone()`, a differenza del gemello in `supabase-fetch.ts`: là il corpo deve restare
 * leggibile per postgrest-js, qui la risposta d'errore è NOSTRA — non la restituiamo a nessuno
 * — e si può consumare direttamente. (È anche il motivo per cui non c'è il `tee` e la sua
 * trappola: il `cancel()` di un ramo clonato non si risolve mai finché l'altro ramo vive.)
 */
async function leggiCorpo(res: Response): Promise<string> {
    try {
        const flusso = res.body;
        // `body` è null su un 204, o su una `Response` costruita senza corpo: `text()` dà ''.
        // Truthiness e non `=== null`: a runtime può arrivare una Response finta (un mock, un
        // polyfill) che il corpo non ce l'ha proprio.
        if (!flusso) return tronca((await res.text()).trim());

        const lettore = flusso.getReader();
        const pezzi: Uint8Array[] = [];
        let letti = 0;
        try {
            while (letti < CORPO_LETTURA_MAX) {
                const { done, value } = await lettore.read();
                if (done) break;
                if (value !== undefined) {
                    pezzi.push(value);
                    letti += value.byteLength;
                }
            }
        } finally {
            void lettore.cancel().catch(() => {});
        }

        // `new Response(bytes).text()` invece di `TextDecoder`: quest'ultimo non è garantito
        // sotto l'ambiente jsdom dei test, `Response` sì. Se il taglio è caduto a metà di una
        // sequenza multibyte mette il carattere di sostituzione — in un corpo troncato va bene.
        return tronca((await new Response(unisci(pezzi, letti)).text()).trim());
    } catch {
        // Un log che tace su ciò che ha perso è un log che mente: si dice che il corpo c'era
        // e non si è potuto leggere, invece di lasciare il campo vuoto come se non ci fosse.
        return '[corpo-illeggibile]';
    }
}

/** `ArrayBuffer` e non `Uint8Array`: il `BodyInit` di questo tsconfig non accetta il secondo. */
function unisci(pezzi: Uint8Array[], totale: number): ArrayBuffer {
    const out = new Uint8Array(totale);
    let scritto = 0;
    for (const p of pezzi) {
        out.set(p, scritto);
        scritto += p.byteLength;
    }
    return out.buffer as ArrayBuffer;
}

function tronca(s: string): string {
    return s.length > CORPO_MAX ? s.slice(0, CORPO_MAX - 1) + '…' : s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Letture difensive: `fetch` può risolversi con qualunque cosa (un mock, un
 * polyfill), e qui dentro non lancia niente.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il messaggio dell'eccezione di rete: è ciò che il chiamante propaga al proprio esito. */
function messaggioDi(err: unknown): string {
    try {
        const m = (err as { message?: unknown } | null | undefined)?.message;
        if (typeof m === 'string' && m !== '') return tronca(m);
        return tronca(String(err));
    } catch {
        return '[errore-illeggibile]';
    }
}

function ok(res: Response): boolean {
    try {
        return res.ok === true;
    } catch {
        return true; // risposta illeggibile: non si inventa un guasto.
    }
}

function statoDi(res: Response): number {
    try {
        return typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
    } catch {
        return 0;
    }
}
