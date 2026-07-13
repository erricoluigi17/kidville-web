import { logEvento, type Livello, type Valore } from './logger';
import { inLogger } from './context';
import { redigiPath } from './redact';

/**
 * Il `fetch` strumentato dei client Supabase.
 *
 * PERCHÉ QUI, E NON UN PROXY SUL CLIENT (verificato nel sorgente della libreria):
 * `PostgrestQueryBuilder.select()/insert()/update()/delete()` NON ritornano `this`, ritornano
 * un oggetto nuovo (`new PostgrestFilterBuilder`): un Proxy su `.from()` morirebbe al primo
 * `.select()`. `{ global: { fetch } }` è invece l'opzione ufficiale e tipizzata di supabase-js,
 * e `@supabase/ssr` la preserva (fa `{ ...options?.global, headers: {…} }`). Un solo punto di
 * intercettazione copre REST + RPC + Storage + Auth + Functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * L'INVARIANTE, ed è la ragione per cui questo modulo esiste:
 *
 *   UNA RISPOSTA POSTGREST CON `!res.ok` PRODUCE SEMPRE UN LOG DI LIVELLO `error`,
 *   ANCHE SE IL CODICE APPLICATIVO LA IGNORA.
 *
 * Nel repo ci sono 73 scritture DB "fire-and-forget" il cui `catch` non scatta MAI, perché
 * PostgREST non lancia: ritorna `{ error }`. Per esempio `src/lib/push/enqueue.ts:51`:
 *
 *     try { await supabase.from('notifiche').insert(rows) }
 *     catch (err) { console.error('[enqueueNotifiche] insert fallito', err) }   // ← mai
 *
 * Stessa struttura in `src/lib/notifiche/triggers.ts` e — peggio — in
 * `src/app/api/admin/gdpr/erase/route.ts:92`, cioè una cancellazione GDPR che può fallire in
 * silenzio. Questo wrapper è l'UNICA cosa che le rende visibili: vede il 4xx HTTP a valle,
 * anche quando sopra non lo guarda nessuno.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * POLITICA DEI LIVELLI. Il principio, in una riga: un 4xx *verso il client* è la risposta
 * corretta a una richiesta sbagliata (informazione); un 4xx *verso il database* è una query
 * sbagliata scritta da NOI (guasto); un 4xx *verso GoTrue* è di nuovo la risposta corretta a
 * una credenziale sbagliata (informazione).
 *
 *   db/rpc/storage, !ok      → `error`  KV_ERR + riga in `app_log`.   ← l'invariante
 *   errore di rete           → `error`  e RILANCIATO.
 *   AbortError               → `info`   il chiamante ha annullato: non è il DB che ha fallito.
 *   auth 5xx                 → `error`  GoTrue è giù: è un guasto.
 *   auth 429                 → `warn`   rate limit: blocca utenti veri, vale la riga in tabella.
 *   auth altri 4xx           → `info`   password sbagliata / sessione scaduta: è il PROTOCOLLO.
 *   risposta ok ma lenta     → `info`   latenza, non guasto (vedi sotto).
 *   risposta ok e veloce     → niente   un logger loquace ACCECA.
 *
 * Perché le query lente sono `info` e non `warn`: `vaPersistito()` persiste i warn, e una query
 * lenta significa DB carico. Persistere una riga per query lenta vorrebbe dire mandare ALTRE
 * scritture allo stesso DB carico — un ciclo di retroazione positiva (DB lento → più insert di
 * log → DB più lento) — e migliaia di righe che sommergerebbero proprio gli errori che questo
 * modulo esiste per far emergere. La latenza si guarda su Vercel, dove la riga arriva lo stesso.
 *
 * Perché l'auth non è trattata come il DB: `resolveIdentity()` chiama `auth.getUser()` a OGNI
 * richiesta API. Un cookie scaduto produce un 400/401 da GoTrue a ogni richiesta: a `error`
 * sarebbe una riga in tabella per ogni richiesta con una sessione vecchia. È lo stesso
 * argomento con cui `with-route.ts` tiene i 4xx a `info`.
 *
 * LA DURATA È PARZIALE, ed è bene saperlo prima di fidarsene. `Date.now()` attorno a `fetch`
 * misura fino agli HEADER: NON include il `await res.text()` + `JSON.parse` che postgrest-js fa
 * dopo, sul corpo. Su un payload grosso (un export, una lista con `select=*`) la durata reale è
 * sottostimata, anche di parecchio. Non si "aggiusta": per misurarla davvero bisognerebbe
 * avvolgere lo stream del corpo, e il costo — un wrapper su OGNI risposta, download binari
 * compresi — non vale un numero più preciso. `ms` è la latenza del DB, non quella della query.
 *
 * RISCHIO NOTO, da tenere d'occhio quando il Task 8 accenderà la persistenza: `.single()`
 * (145 usi nel repo) chiede a PostgREST l'header `application/vnd.pgrst.object+json`, e su ZERO
 * righe PostgREST risponde **406 PGRST116**. Per l'invariante è un `error` — ed è giusto, perché
 * `.single()` dichiara "questa riga esiste" e il codice a valle di solito la usa. Ma se in
 * produzione `code=PGRST116` diventasse rumore di fondo, l'unica riga da cambiare è in
 * `livelloDi()`: declassare a `info` il 406 con `details` che dice "0 rows". Da fare con i
 * numeri in mano, non per ipotesi. (`.maybeSingle()`, 325 usi, NON è un problema: postgrest-js
 * scarica un array e conta le righe in JS — l'HTTP resta 200. Verificato nel sorgente.)
 *
 * Regola d'oro dell'intero modulo: NIENTE qui dentro può lanciare. L'unica eccezione rilanciata
 * è quella di `fetch`, che è del chiamante e non nostra.
 */

type Fetch = typeof fetch;

/** Oltre questa soglia la risposta è "lenta". Solo `info`: vedi la politica dei livelli. */
const LENTA_MS = 500;

/**
 * Tetto del corpo d'errore che ci portiamo dietro quando non è JSON. Il JSON valido si parsa
 * per intero (serve integro), poi `sanificaMessaggio` richiude comunque a 500 caratteri.
 */
const CORPO_MAX = 1_000;

/**
 * Sopra questo `content-length` il corpo d'errore NON si legge. Un errore di PostgREST o di
 * Storage sono poche centinaia di byte; una pagina HTML d'errore sputata da un proxy a monte,
 * o un 413 che rimanda indietro ciò che gli è arrivato, no. `res.clone().text()` bufferizza
 * tutto in RAM prima che noi possiamo troncare: il taglio va fatto PRIMA di leggere.
 */
const CORPO_LETTURA_MAX = 64_000;

export interface Bersaglio {
    area: 'db' | 'rpc' | 'storage' | 'auth' | 'altro';
    nome: string;
}

/**
 * Dall'URL si ricava cosa stiamo facendo. Non lancia mai: su un URL illeggibile ricade su
 * `altro`, perché un log approssimativo è meglio di una richiesta rotta dall'osservabilità.
 *
 * PRIVACY. Si usa solo il `pathname`, e passa da `redigiPath`. Due ragioni distinte:
 *
 *  - la QUERY STRING non entra mai nel nome, ed è dove PostgREST mette i filtri:
 *    `?email=eq.mario.rossi@x.it`, `?codice_fiscale=eq.RSS…`. È il grosso del rischio, e si
 *    chiude usando `pathname` invece di `href`;
 *  - il PATHNAME dello storage è la chiave dell'oggetto, che nel repo contiene id di alunni e
 *    codici fiscali (`/storage/v1/object/fascicoli/RSSMRA…/pagella.pdf`). `redigiPath` la
 *    riduce a pattern. Non è una difesa ridondante: nella riga persistita `operazione` è in
 *    LISTA BIANCA in `redact()` (esce in chiaro, come il nome di route in `with-route.ts`),
 *    quindi `redigiPath` è l'UNICA difesa su quel canale.
 *
 * Limite noto: `redigiPath` collassa i segmenti "lunghi e con almeno una cifra". Tutte le
 * chiavi di upload del repo sono prefissate da un uuid o da `Date.now()` (verificato:
 * tasks/avvisi/gallery/chat/forms/medical-certificates), quindi il nome originale del file —
 * che è l'unico pezzo scelto dall'utente — finisce dentro un segmento opaco e sparisce. Una
 * chiamata futura che caricasse `file.name` GREZZO come primo segmento sfuggirebbe: se
 * succede, il posto dove correggerlo è qui, non nei 239 chiamanti.
 */
export function analizzaBersaglio(url: string): Bersaglio {
    try {
        const { pathname } = new URL(url);
        if (pathname.startsWith('/rest/v1/rpc/')) return bersaglio('rpc', pathname.slice(13));
        if (pathname.startsWith('/rest/v1/')) return bersaglio('db', pathname.slice(9));
        if (pathname.startsWith('/storage/v1/')) return bersaglio('storage', pathname.slice(12));
        if (pathname.startsWith('/auth/v1/')) return bersaglio('auth', pathname.slice(9));
        return bersaglio('altro', pathname);
    } catch {
        return { area: 'altro', nome: '?' };
    }
}

function bersaglio(area: Bersaglio['area'], nome: string): Bersaglio {
    return { area, nome: redigiPath(nome) };
}

/**
 * `base` è iniettabile per i test. Il default NON è `= fetch` (che catturerebbe il globale al
 * CARICAMENTO del modulo): Next 16 patcha `globalThis.fetch` per il proprio caching, e non c'è
 * garanzia che l'abbia già fatto quando questo modulo viene importato. Con la lambda, il fetch
 * globale si risolve a ogni CHIAMATA — quindi si usa sempre quello che Next vuole che si usi,
 * e il comportamento di cache attuale non cambia.
 */
export function creaFetchStrumentato(base?: Fetch): Fetch {
    const chiama: Fetch = base ?? ((input, init) => globalThis.fetch(input, init));

    return async (input, init) => {
        // Dentro il logger non si logga: se la scrittura su `app_log` fallisce e il gestore
        // d'errore logga, si tenta di scrivere di nuovo su `app_log` → ricorsione fino
        // all'esaurimento della memoria. È la seconda difesa: la prima è `createLogClient`,
        // che non è strumentato affatto.
        if (inLogger()) return chiama(input, init);

        const b = descrivi(input, init);
        const t0 = Date.now();

        let res: Response;
        try {
            // Argomenti INTATTI. Non si tocca `init` (né lo si copia): `signal`, `priority`,
            // `cache`, `next` e gli header devono arrivare a Next e a undici esattamente come
            // li ha scritti supabase-js.
            res = await chiama(input, init);
        } catch (err) {
            const campi = { ...b.campi, ms: Date.now() - t0 };
            logEvento(b.area, eAbort(err) ? 'info' : 'error', campi, err);
            // RILANCIARE sempre, e l'errore ORIGINALE: postgrest-js distingue l'AbortError
            // dagli altri (`hint: 'Request was aborted'`) leggendone `name`/`code`.
            throw err;
        }

        const ms = Date.now() - t0;

        try {
            if (!ok(res)) {
                await registraFallimento(b, res, ms);
            } else if (ms > LENTA_MS) {
                logEvento(b.area, 'info', { ...b.campi, stato: stato(res), ms, lenta: true });
            }
        } catch {
            // L'osservabilità non può rompere la risposta che sta osservando: si perde il log.
        }

        return res;
    };
}

interface Descrizione {
    area: Bersaglio['area'];
    /**
     * I nomi dei campi NON sono liberi: `redact()` è a lista bianca PER CHIAVE, e nella riga
     * che va in `app_log` sopravvivono in chiaro solo le chiavi note. `tipo`, `operazione`,
     * `metodo` e `stato` ci sono; `nome` sarebbe peggio che inutile — è in `DA_HASHARE`, quindi
     * `nome: 'alunni'` finirebbe in tabella come `[redatto]` e la riga non direbbe più QUALE
     * tabella ha fallito. È la stessa ragione per cui `with-route.ts` chiama `operazione` il
     * nome della rotta invece di `rt`.
     */
    campi: Record<string, Valore>;
}

/** Non lancia: `input` può essere una stringa, una URL o una Request, e in JS qualunque cosa. */
function descrivi(input: unknown, init: RequestInit | undefined): Descrizione {
    try {
        const { area, nome } = analizzaBersaglio(url(input));
        const tentativo = Number(intestazione(init, 'x-retry-count'));
        return {
            area,
            campi: {
                operazione: nome,
                metodo: metodo(input, init),
                // postgrest-js RITENTA da solo GET/HEAD su 503/520 e sugli errori di rete
                // (3 tentativi, backoff 1s/2s/4s): senza questo campo i log direbbero N query
                // dove ce n'era una sola. Il contatore lo mette la libreria sulla RICHIESTA.
                tentativo: Number.isFinite(tentativo) && tentativo > 0 ? tentativo : undefined,
            },
        };
    } catch {
        return { area: 'altro', campi: { operazione: '?' } };
    }
}

function url(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    // Una Request: se ne legge SOLO `url`. Il corpo non si tocca — leggerlo qui lo
    // consumerebbe per il chiamante.
    const u = (input as { url?: unknown } | null | undefined)?.url;
    return typeof u === 'string' ? u : '';
}

function metodo(input: unknown, init: RequestInit | undefined): string {
    const m = init?.method ?? (input as { method?: unknown } | null | undefined)?.method ?? 'GET';
    return typeof m === 'string' ? m.toUpperCase() : 'GET';
}

/**
 * `init.headers` arriva in tre forme: `Headers` (postgrest-js), oggetto letterale (storage-js,
 * auth-js) o array di coppie. Il nome va passato MINUSCOLO.
 */
function intestazione(init: RequestInit | undefined, nome: string): string | undefined {
    try {
        const h = init?.headers;
        if (h === undefined || h === null) return undefined;
        const get = (h as Headers).get;
        if (typeof get === 'function') return (h as Headers).get(nome) ?? undefined;
        if (Array.isArray(h)) {
            const trovata = h.find((c) => String(c?.[0]).toLowerCase() === nome);
            return trovata === undefined ? undefined : String(trovata[1]);
        }
        const chiave = Object.keys(h as object).find((k) => k.toLowerCase() === nome);
        return chiave === undefined ? undefined : String((h as Record<string, unknown>)[chiave]);
    } catch {
        return undefined;
    }
}

function ok(res: Response): boolean {
    try {
        return res.ok === true;
    } catch {
        return true; // risposta illeggibile: non si inventa un guasto.
    }
}

function stato(res: Response): number | undefined {
    try {
        return typeof res.status === 'number' ? res.status : undefined;
    } catch {
        return undefined;
    }
}

function eAbort(err: unknown): boolean {
    try {
        const e = err as { name?: unknown; code?: unknown } | null | undefined;
        return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
    } catch {
        return false;
    }
}

async function registraFallimento(b: Descrizione, res: Response, ms: number): Promise<void> {
    const s = stato(res) ?? 0;
    const livello = livelloDi(b.area, s);
    const campi = { ...b.campi, stato: s, ms };

    // Il corpo si legge SOLO qui, mai sulle risposte ok: `storage.download()` passa da questo
    // wrapper, e leggerne il corpo distruggerebbe lo streaming e farebbe esplodere la memoria.
    const err = leggeIlCorpo(b.area) ? await erroreDalCorpo(res, s) : undefined;
    logEvento(b.area, livello, campi, err);
}

/**
 * PRIVACY — perché sull'AUTH il corpo NON si legge MAI.
 *
 * Il fetch strumentato è passato anche al session client, quindi vede
 * `POST /auth/v1/token`: nella RICHIESTA c'è la password di un genitore in chiaro, nella
 * risposta ci sono i JWT. Il corpo della richiesta non lo leggiamo mai (nessun ramo di questo
 * modulo lo tocca). Ma il corpo della RISPOSTA d'errore di GoTrue non è contrattualmente
 * ripulito dall'input: le validazioni possono rimandare indietro l'email (`email_exists`,
 * `weak_password` con le sue ragioni), e i formati cambiano da un rilascio all'altro.
 *
 * Fondare una garanzia di privacy su "oggi GoTrue non rimanda indietro ciò che gli hai dato"
 * significa fondarla su un dettaglio implementativo di terzi, sul canale più sensibile che
 * abbiamo. E in cambio di poco: gli errori di GoTrue sono diagnosticamente poveri
 * (`invalid_grant`, `Invalid login credentials`), mentre lo status HTTP dice già tutto ciò che
 * serve — 400/401 credenziali sbagliate, 422 validazione, 429 rate limit, 5xx GoTrue giù.
 * Si rinuncia a un dettaglio che non serve per chiudere una fuga che sarebbe grave.
 *
 * Stessa scelta, per prudenza, su `altro`: è tutto ciò che non sappiamo riconoscere (Functions,
 * Realtime, endpoint futuri). Fail-closed sull'ignoto.
 */
function leggeIlCorpo(area: Bersaglio['area']): boolean {
    return area === 'db' || area === 'rpc' || area === 'storage';
}

function livelloDi(area: Bersaglio['area'], s: number): Livello {
    if (s >= 500 || s === 0) return 'error';
    if (area === 'auth') return s === 429 ? 'warn' : 'info';
    // db, rpc, storage, altro: un 4xx qui è una richiesta sbagliata scritta da noi. È L'INVARIANTE.
    return 'error';
}

/**
 * Il corpo d'errore diventa un Error VERO, non un campo `corpo` sulla riga. Tre motivi:
 *
 *  1. `logEvento(…, err)` fa passare l'errore da `descriviErrore`, che ne estrae `code`,
 *     `message`, `details`, `hint` NEI CAMPI DEDICATI e li sanifica uno per uno. Il `details`
 *     di PostgREST è esattamente dove Postgres scrive `Key (email)=(mario.rossi@…)`, e
 *     `sanificaMessaggio` lo maschera. Un campo `corpo` grezzo, invece, in tabella diventerebbe
 *     `[redatto:str/180]` (non è in lista bianca): illeggibile là dove serve.
 *  2. il `code` finisce nella colonna `app_log.codice`: `WHERE codice = '23505'` in SQL.
 *  3. `new Error()` cattura lo STACK QUI, cioè dentro la catena di chiamate che parte dalla
 *     route: dice quale riga ha emesso la query che ha fallito. È l'informazione che un
 *     `{ error }` ignorato non dà mai.
 *
 * L'Error grezzo non arriva su console: `logErrore`/`logEvento` ne emettono una COPIA
 * sanificata (`erroreNativo`). Qui si costruisce il portatore dei dati, non ciò che si stampa.
 */
async function erroreDalCorpo(res: Response, s: number): Promise<unknown> {
    const testo = await corpo(res);
    const o = comeOggetto(testo);

    const err = new Error(stringa(o.message) ?? stringa(o.msg) ?? stringa(o.error_description)
        ?? troncato(testo) ?? `HTTP ${s}`);
    // Il NOME raggruppa gli errori su Vercel (`get_runtime_errors` raggruppa per error name):
    // uno solo per tutta la superficie Supabase, invece di `Error` mescolato a quelli veri.
    err.name = 'SupabaseHttpError';
    // Letti da `descriviErrore`: `code` → colonna `codice`, `details`/`hint` → sanificati.
    // Lo storage non usa `code`: usa `error` ('not_found', 'InvalidKey') e `statusCode`.
    Object.assign(err, {
        code: stringa(o.code) ?? stringa(o.error_code) ?? stringa(o.error),
        details: stringa(o.details),
        hint: stringa(o.hint),
    });
    return err;
}

async function corpo(res: Response): Promise<string> {
    try {
        const lunghezza = Number(res.headers.get('content-length'));
        if (Number.isFinite(lunghezza) && lunghezza > CORPO_LETTURA_MAX) return '';
        // `clone()` e non `text()`: il corpo deve restare leggibile per il chiamante — è
        // postgrest-js a farne il `JSON.parse` da cui nasce l'oggetto `{ error }`.
        // Lancia se il corpo è già stato consumato: si perde il log, non la risposta.
        return await res.clone().text();
    } catch {
        return '';
    }
}

function comeOggetto(testo: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(testo);
        // Un array (PostgREST lo restituisce in qualche caso di 404) non ha i campi che cerchiamo.
        return v !== null && typeof v === 'object' && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** Solo stringhe non vuote: `hint` è spesso `null`, e `error` a volte è un oggetto. */
function stringa(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
}

function troncato(testo: string): string | undefined {
    const t = testo.trim();
    return t === '' ? undefined : t.slice(0, CORPO_MAX);
}
