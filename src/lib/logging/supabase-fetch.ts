import { logEvento, type Livello, type Valore } from './logger';
import { inLogger } from './context';
import { redigiPath } from './redact';
import { sanificaMessaggio } from './serialize';

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
 *   UN FALLIMENTO APPLICATIVO DI POSTGREST (4xx) PRODUCE SEMPRE UN LOG DI LIVELLO
 *   `error`, PERSISTITO, ANCHE SE IL CODICE APPLICATIVO LO IGNORA.
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
 *
 * L'invariante ha DUE eccezioni, ed entrambe sono state pagate con un guasto misurato, non
 * concesse per comodità. Sono `livelloDi()` (il 406 a zero righe) e `persistibile()` (il DB
 * giù): le si legge lì, col loro perché.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * POLITICA DEI LIVELLI. Il principio, in una riga: un 4xx *verso il client* è la risposta
 * corretta a una richiesta sbagliata (informazione); un 4xx *verso il database* è una query
 * sbagliata scritta da NOI (guasto); un 4xx *verso GoTrue* è di nuovo la risposta corretta a
 * una credenziale sbagliata (informazione).
 *
 *   db/rpc/storage 4xx       → `error` + tabella.  ← l'invariante: sono bug NOSTRI
 *   406 PGRST116 "0 rows"    → `info`              `.single()` su una riga che non c'è
 *   db/rpc 5xx               → `error`, NO tabella il DB è giù: non gli si scrive addosso
 *   errore di rete           → `error`, NO tabella e RILANCIATO
 *   AbortError               → `info`              il chiamante ha annullato: il DB non ha fallito
 *   auth 5xx                 → `error` + tabella   GoTrue è giù (il DB, però, sta bene)
 *   auth 429                 → `warn`  + tabella   rate limit: blocca utenti veri
 *   auth altri 4xx           → `info`              password sbagliata / sessione scaduta
 *   3xx                      → `info`              non è un guasto (`res.ok` è falso per un 304)
 *   ok ma lenta              → `info`              latenza, non guasto (vedi sotto)
 *   ok e veloce              → niente              un logger loquace ACCECA
 *
 * Perché le query lente sono `info` e non `warn`: `vaPersistito()` persiste i warn, e una query
 * lenta significa DB carico. Persistere una riga per query lenta vorrebbe dire mandare ALTRE
 * scritture allo stesso DB carico — un ciclo di retroazione positiva — e migliaia di righe che
 * sommergerebbero proprio gli errori che questo modulo esiste per far emergere. La latenza si
 * guarda su Vercel, dove la riga arriva lo stesso.
 *
 * Perché l'auth non è trattata come il DB: `resolveIdentity()` chiama `auth.getUser()` a OGNI
 * richiesta API. Un cookie scaduto produce un 400/401 da GoTrue a ogni richiesta: a `error`
 * sarebbe una riga in tabella per ogni richiesta con una sessione vecchia. È lo stesso
 * argomento con cui `with-route.ts` tiene i 4xx a `info`.
 *
 * LA DURATA È PARZIALE, ed è bene saperlo prima di fidarsene. `Date.now()` attorno a `fetch`
 * misura fino agli HEADER: NON include il `await res.text()` + `JSON.parse` che postgrest-js fa
 * dopo, sul corpo. Su un payload grosso la durata reale è sottostimata, anche di parecchio. Non
 * si "aggiusta": per misurarla davvero bisognerebbe avvolgere lo stream del corpo, e il costo —
 * un wrapper su OGNI risposta, download binari compresi — non vale un numero più preciso.
 * `ms` è la latenza del DB, non quella della query.
 *
 * Regola d'oro dell'intero modulo: NIENTE qui dentro può lanciare. L'unica eccezione rilanciata
 * è quella di `fetch`, che è del chiamante e non nostra.
 */

type Fetch = typeof fetch;

/** Oltre questa soglia la risposta è "lenta". Solo `info`: vedi la politica dei livelli. */
const LENTA_MS = 500;

/** Tetto del corpo d'errore che ci portiamo dietro quando non è JSON. */
const CORPO_MAX = 1_000;

/**
 * Tetto REALE, in byte, di quanto corpo d'errore si legge. Non è un'euristica su
 * `content-length` (che può mancare — risposta chunked — o non essere un numero, e in entrambi
 * i casi un confronto `> MAX` è FALSO e non ferma niente: un corpo da 5 MB senza
 * `content-length` verrebbe bufferizzato per intero). Si legge lo stream a pezzi e si smette:
 * il limite è quello che è scritto qui, non quello che dichiara chi risponde.
 */
const CORPO_LETTURA_MAX = 64_000;

/**
 * Il retry di postgrest-js, ricopiato dal suo sorgente (`DEFAULT_MAX_RETRIES`,
 * `RETRYABLE_STATUS_CODES`, `RETRYABLE_METHODS`). Serve a PREVEDERE se la risposta che abbiamo
 * in mano verrà ritentata — vedi `verràRitentato`.
 *
 * È un accoppiamento a un dettaglio interno di una libreria, e va detto: se postgrest-js cambia
 * la sua politica di retry, qui si sbaglia a contare. Il modo di sbagliare, però, è mite (una
 * riga di log in più o in meno) e il test lo blocca: `X-Retry-Count` resta l'unica cosa su cui
 * ci si appoggia davvero.
 */
const TENTATIVI_MAX = 3;
const STATI_RITENTABILI = new Set([503, 520]);
const METODI_RITENTABILI = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface Bersaglio {
    area: 'db' | 'rpc' | 'storage' | 'auth' | 'altro';
    nome: string;
}

/**
 * Dall'URL si ricava cosa stiamo facendo. Non lancia mai: su un URL illeggibile ricade su
 * `altro`, perché un log approssimativo è meglio di una richiesta rotta dall'osservabilità.
 *
 * PRIVACY. Si usa solo il `pathname`, e passa da `redigiPath` E POI da `sanificaMessaggio`.
 * Tre ragioni distinte, e la terza è quella che rende necessarie tutte e due le passate:
 *
 *  - la QUERY STRING non entra mai nel nome, ed è dove PostgREST mette i filtri:
 *    `?email=eq.mario.rossi@x.it`, `?codice_fiscale=eq.RSS…`. Si chiude usando `pathname`;
 *  - il PATHNAME dello storage è la chiave dell'oggetto, che nel repo contiene id di alunni e
 *    codici fiscali (`/storage/v1/object/fascicoli/RSSMRA…/pagella.pdf`): `redigiPath` la
 *    riduce a pattern;
 *  - ma `redigiPath` collassa i segmenti "lunghi E CON ALMENO UNA CIFRA", e un codice fiscale
 *    in OMOCODIA PIENA (`RSSMRALMTLLASLMS`: 16 caratteri, zero cifre — l'Agenzia delle Entrate
 *    sostituisce le cifre con lettere quando due codici collidono) gli passa in mezzo. Sulla
 *    riga di Vercel lo salverebbe comunque `quota()`, che sanifica ogni stringa; ma nella riga
 *    che va in TABELLA il campo `operazione` è in LISTA BIANCA — `redact()` lo lascia in chiaro
 *    e NON gli applica `sanificaMessaggio`. Su quel canale non c'è nessun altro a guardare.
 *    Perciò si sanifica QUI, alla sorgente: una volta sola, e vale per entrambi i canali.
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
    return { area, nome: sanificaMessaggio(redigiPath(nome)) };
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
            registraErroreDiRete(b, err, Date.now() - t0);
            // RILANCIARE sempre, e l'errore ORIGINALE: postgrest-js distingue l'AbortError
            // dagli altri (`hint: 'Request was aborted'`) leggendone `name`/`code`.
            throw err;
        }

        const ms = Date.now() - t0;

        try {
            if (!ok(res)) {
                await registraFallimento(b, res, ms);
            } else if (ms > LENTA_MS) {
                logEvento(b.area, 'info', campiDi(b, { stato: stato(res), ms, lenta: true }));
            }
        } catch {
            // L'osservabilità non può rompere la risposta che sta osservando: si perde il log.
        }

        return res;
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il bersaglio della chiamata.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Descrizione {
    area: Bersaglio['area'];
    nome: string;
    metodo: string;
    /** `X-Retry-Count`: 0 al primo colpo. Lo mette postgrest-js sulla RICHIESTA. */
    tentativo: number;
}

/** Non lancia: `input` può essere una stringa, una URL o una Request, e in JS qualunque cosa. */
function descrivi(input: unknown, init: RequestInit | undefined): Descrizione {
    try {
        const { area, nome } = analizzaBersaglio(url(input));
        const n = Number(intestazione(init, 'x-retry-count'));
        return {
            area,
            nome,
            metodo: metodo(input, init),
            tentativo: Number.isFinite(n) && n > 0 ? n : 0,
        };
    } catch {
        return { area: 'altro', nome: '?', metodo: 'GET', tentativo: 0 };
    }
}

/**
 * I nomi dei campi NON sono liberi: `redact()` è a lista bianca PER CHIAVE, e nella riga che va
 * in `app_log` sopravvivono in chiaro solo le chiavi note. `operazione`, `metodo` e `stato` ci
 * sono; `nome` sarebbe peggio che inutile — è in `DA_HASHARE`, quindi `nome: 'alunni'` finirebbe
 * in tabella come `[redatto]` e la riga non direbbe più QUALE tabella ha fallito. È la stessa
 * ragione per cui `with-route.ts` chiama `operazione` il nome della rotta.
 */
function campiDi(b: Descrizione, extra: Record<string, Valore>): Record<string, Valore> {
    return {
        operazione: b.nome,
        metodo: b.metodo,
        tentativo: b.tentativo > 0 ? b.tentativo : undefined,
        ...extra,
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il retry di postgrest-js: si emette SOLO il tentativo finale.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * postgrest-js RITENTA DA SOLO GET/HEAD/OPTIONS su 503/520 e sugli errori di rete: 3 ritentativi,
 * backoff 1s/2s/4s → 4 chiamate HTTP per UNA query applicativa.
 *
 * Se le emettessimo tutte, un DB in affanno riceverebbe da noi 4 righe di errore, cioè 4
 * scritture su `app_log` — che sono a loro volta richieste allo STESSO database a terra. Misurato
 * sul client vero, prima di questa correzione: 8 richieste HTTP totali (4 query + 4 log) per una
 * sola `select`. Un 503 è precisamente il momento in cui il DB non può assorbire il doppio del
 * traffico, e noi glielo raddoppiavamo.
 *
 * Perciò i tentativi INTERMEDI non si emettono: si emette solo quello che postgrest-js NON
 * ritenterà. Non è perdita di informazione — `tentativo=3` sulla riga finale dice già che ce ne
 * sono stati altri tre.
 *
 * `stato` assente = errore di rete (che postgrest ritenta con le stesse regole).
 */
function verràRitentato(b: Descrizione, stato: number | undefined): boolean {
    // Solo postgrest ritenta: storage-js e auth-js non hanno nessun retry. Sopprimere lì
    // significherebbe perdere il log, non risparmiarlo.
    if (b.area !== 'db' && b.area !== 'rpc') return false;
    if (!METODI_RITENTABILI.has(b.metodo)) return false;
    if (b.tentativo >= TENTATIVI_MAX) return false;
    return stato === undefined || STATI_RITENTABILI.has(stato);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Emissione.
 * ──────────────────────────────────────────────────────────────────────────── */

function registraErroreDiRete(b: Descrizione, err: unknown, ms: number): void {
    try {
        const abort = eAbort(err);
        // Un abort non viene mai ritentato da postgrest (lo rilancia subito): va emesso ora.
        if (!abort && verràRitentato(b, undefined)) return;
        // MAI in tabella: se l'host Supabase non si raggiunge, non si raggiunge nemmeno per
        // scriverci il log. Vedi `persistibile`.
        logEvento(b.area, abort ? 'info' : 'error', campiDi(b, { ms }), err, { persisti: false });
    } catch {
        // Fail-open: l'errore di rete lo rilancia comunque il chiamante.
    }
}

async function registraFallimento(b: Descrizione, res: Response, ms: number): Promise<void> {
    const s = stato(res) ?? 0;
    if (verràRitentato(b, s)) return;

    // Il corpo si legge SOLO qui, mai sulle risposte ok: `storage.download()` passa da questo
    // wrapper, e leggerne il corpo distruggerebbe lo streaming e farebbe esplodere la memoria.
    const err = leggeIlCorpo(b.area) ? await erroreDalCorpo(res, s) : undefined;

    logEvento(b.area, livelloDi(b.area, s, err), campiDi(b, { stato: s, ms }), err, {
        persisti: persistibile(b.area, s),
    });
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
 *
 * Stessa scelta, per prudenza, su `altro`: è tutto ciò che non sappiamo riconoscere (Functions,
 * Realtime, endpoint futuri). Fail-closed sull'ignoto.
 */
function leggeIlCorpo(area: Bersaglio['area']): boolean {
    return area === 'db' || area === 'rpc' || area === 'storage';
}

/** PostgREST: «The result contains 0 rows». Il `.single()` chiedeva una riga, non c'era. */
const ZERO_RIGHE = /\b0 rows\b/;

function livelloDi(area: Bersaglio['area'], s: number, err: unknown): Livello {
    // `res.ok` è falso anche per un 304. Un 3xx non è un guasto di nessuno.
    if (s >= 300 && s < 400) return 'info';
    if (s >= 500 || s === 0) return 'error';
    if (area === 'auth') return s === 429 ? 'warn' : 'info';

    // ECCEZIONE ALL'INVARIANTE, pagata con un guasto misurato.
    //
    // `.single()` chiede a PostgREST l'header `application/vnd.pgrst.object+json`, e su ZERO
    // righe PostgREST risponde 406 PGRST116. Ci sono 147 `.single()` nel repo, e il caso "0
    // righe" è spesso un flusso NORMALE, tollerato apposta: `require-staff.ts:132` fa `.single()`
    // su `utenti` e scrive `if (error || !data) return null`.
    //
    // Conseguenza, se questo restasse `error`: un utente con la sessione ancora viva ma senza
    // riga `utenti` — per esempio uno CANCELLATO dalla route GDPR, cioè proprio il caso che
    // questo modulo cita come sua ragion d'essere — scriverebbe una riga d'errore in `app_log`
    // a OGNI richiesta API, finché il cookie campa. Il canale che deve far emergere gli errori
    // veri verrebbe sommerso dal più prevedibile dei non-errori.
    //
    // Non è un errore del database: è una riga che non c'è. E il chiamante lo sa già, perché
    // `.single()` gli restituisce `{ error }`. Resta `info`: visibile su Vercel, fuori dalla
    // tabella. Un 406 che dice "2 rows" (duplicato dove ci si aspettava unicità) NON è coperto
    // da questa eccezione: quello è un bug, e resta `error`.
    if (s === 406 && zeroRighe(err)) return 'info';

    // db, rpc, storage: un 4xx qui è una richiesta sbagliata scritta da noi. È L'INVARIANTE.
    return 'error';
}

function zeroRighe(err: unknown): boolean {
    try {
        const e = err as { code?: unknown; details?: unknown } | null | undefined;
        if (e?.code !== 'PGRST116') return false;
        return typeof e.details === 'string' && ZERO_RIGHE.test(e.details);
    } catch {
        return false;
    }
}

/**
 * ECCEZIONE ALL'INVARIANTE, la seconda: non ha senso scrivere su un DB rotto per dire che il DB
 * è rotto.
 *
 * Un 5xx da PostgREST significa che il database non risponde. La riga di log andrebbe scritta su
 * quello stesso database: fallirebbe comunque, e nel frattempo aggiungerebbe carico a un sistema
 * che è già in affanno — esattamente quando non può assorbirlo. Con il retry di postgrest-js in
 * mezzo, quel carico si moltiplica (vedi `verràRitentato`).
 *
 * La riga esce lo stesso su Vercel, a livello `error`. Ed è lì che si guarda un DB giù: la
 * tabella, in quel momento, non è raggiungibile per definizione.
 *
 * Storage e Auth NON sono coperti: sono servizi diversi, e un loro 5xx non implica che il
 * database sia giù — anzi, quella riga in tabella è preziosa e si può scrivere davvero.
 */
function persistibile(area: Bersaglio['area'], s: number): boolean {
    return !(s >= 500 && (area === 'db' || area === 'rpc'));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il corpo dell'errore.
 * ──────────────────────────────────────────────────────────────────────────── */

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
 * L'Error grezzo non arriva su console: `logEvento` ne emette una COPIA sanificata
 * (`erroreNativo`). Qui si costruisce il portatore dei dati, non ciò che si stampa.
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

/**
 * Legge il corpo con un limite VERO, a pezzi. Il taglio avviene mentre si legge, non dopo:
 * `res.clone().text()` bufferizzerebbe l'intera risposta in RAM prima di poterla troncare, e una
 * pagina HTML d'errore sputata da un proxy a monte non ha nessun obbligo di essere piccola né di
 * dichiarare un `content-length`.
 */
async function corpo(res: Response): Promise<string> {
    try {
        // `clone()` e non `text()`: il corpo deve restare leggibile per il chiamante — è
        // postgrest-js a farne il `JSON.parse` da cui nasce l'oggetto `{ error }`.
        // Lancia se il corpo è già stato consumato: si perde il log, non la risposta.
        const copia = res.clone();
        const flusso = copia.body;
        if (flusso === null) return '';

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
            // `void`, MAI `await`. `clone()` fa un `tee()`, e la promise di `cancel()` su un
            // ramo si risolve solo quando ANCHE L'ALTRO ramo viene annullato — cosa che non
            // succederà mai, perché l'altro ramo è quello che il chiamante deve leggere.
            // Aspettarla è un deadlock: la richiesta resterebbe appesa per sempre. (Trovato
            // dal test sul corpo da 5 MB: senza, va in timeout.)
            //
            // Chiamarla comunque serve: marca il ramo come annullato, così il `tee` smette di
            // accodargli i pezzi che noi non leggeremo più. Il chiamante legge il suo, intatto.
            void lettore.cancel().catch(() => {});
        }

        // `new Response(bytes).text()` invece di `TextDecoder`: quest'ultimo non è garantito
        // sotto l'ambiente jsdom dei test, `Response` sì (lo usa tutto il modulo). Decodifica
        // in UTF-8 e, se il taglio è caduto a metà di una sequenza multibyte, mette il
        // carattere di sostituzione — che in un corpo d'errore troncato va benissimo.
        return await new Response(unisci(pezzi, letti)).text();
    } catch {
        return '';
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

/* ────────────────────────────────────────────────────────────────────────────
 * Letture difensive: qui dentro non lancia niente.
 * ──────────────────────────────────────────────────────────────────────────── */

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

/** Solo stringhe non vuote: `hint` è spesso `null`, e `error` a volte è un oggetto. */
function stringa(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
}

function troncato(testo: string): string | undefined {
    const t = testo.trim();
    return t === '' ? undefined : t.slice(0, CORPO_MAX);
}
