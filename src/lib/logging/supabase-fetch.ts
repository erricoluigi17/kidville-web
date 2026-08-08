import { logEvento, type Livello, type Valore } from './logger';
import { contesto, inLogger } from './context';
import { redigiPath } from './redact';
import { sanificaMessaggio } from './serialize';
import { conTetto, eTimeout, erroreTimeout, fraseScadenza, tettoNostro, tettoSano } from './tetto';

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
 * ⚠️ E IL LIVELLO NON BASTA A GARANTIRLO. Fino al 2026-08-01 «gli `info` di questo modulo non
 * finiscono in tabella» era vero per un accidente: nessuna delle cinque aree (`db`, `rpc`,
 * `storage`, `auth`, `altro`) era in `EVENTI_PERSISTITI`. Il giorno in cui `storage` è entrato
 * in allowlist — per una ragione giusta e distante, far arrivare in tabella il successo del
 * caricamento di un allegato — ogni lettura lenta e ogni 3xx dello Storage hanno cominciato a
 * scriversi in `app_log`, in silenzio, senza che nessuno avesse deciso niente. Perciò adesso la
 * regola è scritta QUI, dove sta la ragione: `daPersistere()` esclude gli `info` di questo
 * modulo qualunque cosa dica l'allowlist. Un `logEvento('storage','info',…)` APPLICATIVO —
 * l'upload riuscito — continua a persistersi: è un successo di dominio, non latenza.
 *
 * IL RUMORE HA UN TETTO, e non è la soglia. Misurato il 2026-07-31: una `GET /api/avvisi` con 9
 * avvisi produceva 35 righe, 34 delle quali `lenta=true` — un terzo delle 100 righe che una
 * lettura dei log di Vercel restituisce, bruciate da un'apertura della bacheca (l'N+1 del
 * cockpit: quattro query per avviso). Alzare `LENTA_MS` avrebbe curato il sintomo nel posto
 * sbagliato: la soglia è tarata sulla PRODUZIONE, dove una query da mezzo secondo è davvero
 * anomala; è in locale, contro un Postgres remoto, che 700-900 ms sono la norma. E se domani il
 * database rallentasse davvero, con la sola soglia si tornerebbe a 34 righe proprio nel momento
 * in cui i log servono. Il tetto per richiesta (`SOGLIE_LENTE`) invece regge in entrambi i casi:
 * dice che è lento, dice quante volte, e non acceca chi legge.
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * E DA QUI PASSA ANCHE LA RESILIENZA (2026-08-03, sera). Vedi `TETTO_MS_DEFAULT`.
 *
 * Fino a quel giorno questo file diceva «Argomenti INTATTI. Non si tocca `init` (né lo si
 * copia)», e non aveva nessun tetto di tempo. La mattina dello stesso giorno il gemello
 * `external.ts` ne aveva ricevuto uno, perché era stato MISURATO che un bersaglio che accetta
 * la connessione e tace tiene appesa la `fetch` **150 secondi senza eccezione**. Qui no — e da
 * qui passano TUTTE le chiamate PostgREST e auth dell'applicazione: un Supabase che accetta e
 * tace appendeva la route esattamente come faceva un provider, col gate verde.
 *
 * La correzione non è stata copiare il tetto: il meccanismo vive in `./tetto` e lo usano
 * entrambe le strade, con un lock che impedisce che torni a essere scritto due volte
 * (`__tests__/lib/logging-tetto.test.ts`). Qui restano i NUMERI, che sono l'unica cosa che di
 * questo modulo è davvero.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

type Fetch = typeof fetch;

/** Oltre questa soglia la risposta è "lenta". Solo `info`: vedi la politica dei livelli. */
const LENTA_MS = 500;

/**
 * Quante righe «lenta» può emettere UNA richiesta: si emette alla 1ª, alla 10ª, alla 100ª.
 *
 * Non è un troncamento — è una scala. La prima riga dice DOVE (quale tabella, quanti ms); le
 * successive dicono che non è un caso isolato, e portano il conteggio raggiunto (`lente=10`),
 * così chi legge sa che sotto ce n'erano altre nove. Una richiesta patologica costa al massimo
 * tre righe invece di trentaquattro, e il tetto cresce col logaritmo del disastro: se un giorno
 * ne servissero mille, la riga `lente=1000` c'è.
 *
 * Perché non «una riga di sintesi a fine richiesta», che sarebbe la forma migliore: chi chiude
 * la richiesta è `withRoute`, e la sintesi andrebbe emessa da lì. Si può fare, e va fatto —
 * ma è un altro modulo e un altro intervento; questa scala dà lo stesso tetto senza toccarlo.
 */
const SOGLIE_LENTE = new Set([1, 10, 100, 1_000]);

/**
 * Il contatore vive APPESO ALL'OGGETTO DI CONTESTO, non in una variabile di modulo.
 *
 * Una variabile di modulo sarebbe condivisa fra le richieste concorrenti (su Fluid Compute più
 * invocazioni girano nello stesso processo Node) — è precisamente ciò che le regole in testa a
 * `context.ts` vietano — e, non azzerandosi mai, dopo mille query lente renderebbe il canale
 * MUTO per sempre. Una `WeakMap` chiavata sullo store della richiesta dà un contatore per
 * richiesta senza che il contesto debba sapere niente di questo modulo, e sparisce con lei.
 *
 * Fuori da una richiesta (cron, boot, `waitUntil`) non c'è store e quindi non c'è tetto: il
 * volume lì è basso e nessuno sta leggendo un incidente in diretta. Scelta dichiarata.
 */
const lentePerRichiesta = new WeakMap<object, { n: number }>();

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
 * IL TETTO DI TEMPO, in millisecondi, su una chiamata a Supabase.
 *
 * PERCHÉ 15 SECONDI, e non un numero scelto a occhio. È il valore già MISURATO su GoTrue nello
 * stesso ciclo: al collaudo dell'accesso una risposta lenta ma VERA è arrivata a 12 secondi, ed
 * è la ragione per cui `TETTO_ACCESSO_MS` (`src/lib/auth/errore-accesso.ts`) sta a 15 e non più
 * in basso. Un accesso lento deve poter riuscire; un accesso che non risponde mai no. Lo stesso
 * numero copre il lato server, dove `resolveIdentity()` chiama `auth.getUser()` a OGNI
 * richiesta API: se GoTrue accetta e tace, senza tetto NESSUNA route risponde più.
 *
 * Sul database il tetto non taglia mai una query lecita, e va detto perché: PostgREST ha il suo
 * `statement_timeout` (ordine dei secondi) e risponde con un errore molto prima. Un silenzio di
 * quindici secondi non è una query lenta — è una connessione appesa.
 *
 * ⚠️ SULL'AUTH QUESTO È IL TETTO DI UN TENTATIVO, NON DELLA CHIAMATA: nel caso peggiore la
 * strada auth ne spende DUE, cioè ~30,2 s. Il numero è letto sul sorgente della libreria, non
 * dedotto:
 *
 *  · `@supabase/auth-js` avvolge QUALUNQUE eccezione del fetch — la nostra scadenza compresa —
 *    in un `AuthRetryableFetchError` (`lib/fetch.js`, `handleError()`: se l'errore non somiglia
 *    a una `Response`, è ritentabile per definizione). Il nome e il `code` che ci mettiamo noi
 *    lì non li guarda nessuno;
 *  · `_refreshAccessToken` ritenta finché `Date.now() + 200·2^n − inizio < 30_000`
 *    (`AUTO_REFRESH_TICK_DURATION_MS`). Con un tetto di 15 s: il 1° tentativo scade a 15.000
 *    (15.000 + 200 < 30.000 → si dorme 200 ms e si ritenta), il 2° a 30.200 (30.200 + 400 ≥
 *    30.000 → si smette). Due tentativi, ~30,2 s in tutto.
 *
 * NON C'È LA SCORCIATOIA CHE ABBIAMO CON POSTGREST. Là il retry si disinnesca dando all'errore
 * il `code: 'ABORT_ERR'` che postgrest-js riconosce (vedi `abortDaScadenza`); qui il predicato
 * di ritentabilità non guarda l'errore, guarda solo il tempo trascorso. L'unica leva sarebbe
 * abbassare il tetto dell'auth — ma dimezzarlo per far tornare il conto significherebbe
 * bocciare a 7,5 s un accesso lento e VERO da 12 s, che è il guasto opposto e peggiore.
 *
 * Vale sul percorso di RINNOVO (`_callRefreshToken` → `_refreshAccessToken`), non su ogni
 * chiamata: un `getUser()` con un access token ancora valido fa una richiesta sola e si ferma
 * al tetto. Il rinnovo però è ordinario — l'access token dura un'ora — quindi il caso peggiore
 * è ordinario anche lui. `__tests__/lib/logging-tetto.test.ts` blocca questa aritmetica sul
 * pacchetto vero: se un aggiornamento cambia la politica, lo si scopre quel giorno.
 *
 * IL TAGLIO DI PIATTAFORMA RESTA IL LIMITE ESTERNO: un tetto più alto di quello non scatta mai.
 * `__tests__/lib/logging-tetto.test.ts` pretende che nessuna area superi i 20 secondi — un
 * ancoraggio ASSOLUTO, perché un test che pinna solo l'ordine relativo resta verde anche se
 * qualcuno moltiplica tutta la tabella per sessanta.
 */
const TETTO_MS_DEFAULT = 15_000;

/**
 * Le aree per cui il default non è il numero giusto. Volutamente corta: una deroga deve dire
 * perché.
 *
 * `storage` — non è una query, è un file. Un upload da 10 MB (il tetto della chat) o il
 * download di un fascicolo passano da qui, e il corpo si trasferisce DENTRO la stessa `fetch`
 * che il tetto governa: tagliarlo a metà trasferimento trasformerebbe una consegna lenta ma
 * riuscita in un fallimento. Server-to-server venti secondi sono larghissimi; da un client
 * lento non sarebbero bastati, ma questo `fetch` non gira mai in un browser.
 */
export const TETTI_MS_AREA: ReadonlyMap<string, number> = new Map<string, number>([
    ['storage', 20_000],
]);

/**
 * IL MASSIMO ASSOLUTO che chi costruisce il client può chiedere con `timeoutMs`.
 *
 * Stessa ragione del gemello (`TETTO_MS_MAX` in `external.ts`): il taglio di piattaforma è il
 * limite esterno, e un tetto più alto non scatta mai — chiederne uno di mezz'ora è rimettere
 * il difetto dentro dalla porta che esiste per tenerlo fuori. 20 secondi perché è il valore di
 * `storage`, la deroga più larga di questa tabella: sotto si stringe quanto si vuole.
 *
 * NON tosa il valore della tabella, di proposito: quello lo misura l'ancoraggio assoluto in
 * `__tests__/lib/logging-tetto.test.ts`. Vedi `tettoSano` in `./tetto`.
 */
const TETTO_MS_MAX = 20_000;

/**
 * Quanto si aspetta questa chiamata: la richiesta di chi ha costruito il client (mai oltre
 * `TETTO_MS_MAX`), poi il tetto dell'area, poi il default. Non ha stato ed è esportata perché
 * la tabella qui sopra sia verificabile senza aspettare quindici secondi per volta.
 *
 * Un valore assurdo non diventa «nessun tetto»: vedi `tettoSano` in `./tetto`.
 */
export function tettoMsArea(area: string, richiesto?: number): number {
    try {
        return tettoSano(richiesto, TETTI_MS_AREA.get(area) ?? TETTO_MS_DEFAULT, TETTO_MS_MAX);
    } catch {
        return TETTO_MS_DEFAULT;
    }
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

export interface OpzioniStrumento {
    /**
     * Il tetto di tempo di questo client, in millisecondi. Default: quello dell'area (vedi
     * `tettoMsArea`). Sta sul FACTORY e non sulla singola chiamata perché il chiamante vero è
     * supabase-js, che di questo wrapper non sa niente: chi può decidere è chi costruisce il
     * client. Per la singola chiamata la valvola esiste già ed è quella di sempre — un
     * `init.signal` proprio, che vince su tutto.
     */
    timeoutMs?: number;
}

/**
 * `base` è iniettabile per i test. Il default NON è `= fetch` (che catturerebbe il globale al
 * CARICAMENTO del modulo): Next 16 patcha `globalThis.fetch` per il proprio caching, e non c'è
 * garanzia che l'abbia già fatto quando questo modulo viene importato. Con la lambda, il fetch
 * globale si risolve a ogni CHIAMATA — quindi si usa sempre quello che Next vuole che si usi,
 * e il comportamento di cache attuale non cambia.
 */
export function creaFetchStrumentato(base?: Fetch, opzioni?: OpzioniStrumento): Fetch {
    const chiama: Fetch = base ?? ((input, init) => globalThis.fetch(input, init));

    return async (input, init) => {
        // Dentro il logger non si logga: se la scrittura su `app_log` fallisce e il gestore
        // d'errore logga, si tenta di scrivere di nuovo su `app_log` → ricorsione fino
        // all'esaurimento della memoria. È la seconda difesa: la prima è `createLogClient`,
        // che non è strumentato affatto.
        //
        // Qui non si mette nemmeno il tetto, ed è una scelta: questo ramo è la rete SOTTO la
        // rete (`createLogClient` non passa affatto da qui), e attaccarci una scadenza
        // vorrebbe dire ricalcolare l'area — cioè lavoro nel percorso che esiste per non farne.
        if (inLogger()) return chiama(input, init);

        const b = descrivi(input, init);
        const tetto = tettoMsArea(b.area, opzioni?.timeoutMs);
        // Se il chiamante governa il signal, `conTetto` NON applica `tetto`: la scadenza che
        // eventualmente arriva è la SUA, e il messaggio non deve spacciarla per la nostra.
        const nostro = tettoNostro(input, init);
        const t0 = Date.now();

        let res: Response;
        try {
            // Argomenti INTATTI, TRANNE il tetto di tempo. `signal`, `priority`, `cache`, `next`
            // e gli header arrivano a Next e a undici esattamente come li ha scritti
            // supabase-js; l'unica aggiunta è una scadenza, e solo quando il chiamante non ne
            // governa già una di sua (vedi `conTetto`). Senza, una connessione accettata e muta
            // teneva appesa la route per sempre — misurato: 150 secondi, senza eccezione.
            res = await chiama(input, conTetto(input, init, tetto));
        } catch (err) {
            const ms = Date.now() - t0;
            const scaduto = eTimeout(err);
            registraErroreDiRete(
                b,
                scaduto
                    ? erroreTimeout(NOME_SCADENZA, 'da Supabase', nostro ? tetto : null, err, ms)
                    : err,
                ms,
                scaduto,
            );
            // RILANCIARE sempre. Sugli errori NON nostri si rilancia l'originale: postgrest-js
            // distingue l'AbortError dagli altri (`hint: 'Request was aborted'`) leggendone
            // `name`/`code`. Su una SCADENZA si rilancia invece la nostra etichetta — vedi
            // `abortDaScadenza`, che spiega perché è l'opposto di una perdita d'informazione.
            throw scaduto ? abortDaScadenza(nostro ? tetto : null, ms, err) : err;
        }

        const ms = Date.now() - t0;

        try {
            const esito = esitoDi(res);
            if (esito === 'ko') {
                await registraFallimento(b, res, ms);
            } else if (esito === 'illeggibile') {
                registraIlleggibile(b, res, ms);
            } else if (ms > LENTA_MS) {
                registraLenta(b, res, ms);
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

function registraErroreDiRete(b: Descrizione, err: unknown, ms: number, scaduto: boolean): void {
    try {
        const abort = !scaduto && eAbort(err);
        // Un abort — e una scadenza — non vengono mai ritentati da postgrest (li rilancia
        // subito): vanno emessi ora, o non li emette nessuno.
        if (!abort && !scaduto && verràRitentato(b, undefined)) return;
        // Una scadenza NON è un annullamento chiesto dal chiamante: resta `error`, perché è
        // esattamente il caso in cui qualcuno deve accorgersene.
        //
        // IL `!scaduto` DAVANTI A `eAbort` OGGI NON CAMBIA NULLA, e va detto invece di
        // spacciarlo per essenziale (qui c'era scritto che «`eAbort` sarebbe vero anche per la
        // nostra etichetta»: è falso). Al logger arriviamo con l'errore di `erroreTimeout` —
        // `name: 'SupabaseTimeoutError'`, `code: 'timeout'` — su cui `eAbort` è già falso.
        // Resta perché in questo ramo girano DUE errori diversi e simili: quello che si LOGGA
        // (qui) e quello che si RILANCIA a postgrest-js, che porta `code: 'ABORT_ERR'` di
        // proposito (vedi `abortDaScadenza`). Il giorno in cui i due si scambiassero di posto —
        // ed è uno scambio di una riga — senza questa guardia una scadenza si declasserebbe a
        // `info` in silenzio. Costa un `&&`; il lock è in `__tests__/lib/logging-tetto.test.ts`.
        //
        // MAI in tabella: se l'host Supabase non si raggiunge (o non risponde), non si raggiunge
        // nemmeno per scriverci il log. Vedi `persistibile`.
        logEvento(b.area, abort ? 'info' : 'error', campiDi(b, { ms }), err, { persisti: false });
    } catch {
        // Fail-open: l'errore di rete lo rilancia comunque il chiamante.
    }
}

/**
 * L'errore che si RILANCIA a supabase-js quando è scaduto il tetto. NON è quello che si logga,
 * e i due hanno due mestieri diversi — è l'unico punto del modulo in cui vale la pena averne due.
 *
 * PERCHÉ NON BASTA RILANCIARE L'ORIGINALE. postgrest-js ritenta da solo GET/HEAD/OPTIONS sugli
 * errori di rete: 3 ritentativi, backoff 1s/2s/4s. Su un errore che fallisce SUBITO (connessione
 * rifiutata) costa il solo backoff ed è la cosa giusta da fare; su una SCADENZA costerebbe un
 * tetto INTERO per tentativo — quattro attese piene più sette secondi, cioè tanto quanto non
 * avere un tetto. L'unica scorciatoia che postgrest-js concede è il suo primo controllo:
 *
 *     if (fetchError?.name === 'AbortError' || fetchError?.code === 'ABORT_ERR') throw fetchError
 *
 * (`node_modules/@supabase/postgrest-js/dist/index.cjs`, ramo `catch (fetchError)`). Il
 * `TimeoutError` che arriva da `AbortSignal.timeout` non lo soddisfa: `code` è `23`, non
 * `'ABORT_ERR'`. Quindi il `code` glielo diamo noi.
 *
 * NON SI PERDE NIENTE, ed è il punto: `cause` porta il DOMException originale, il messaggio
 * porta il numero di millisecondi, il nome resta il nostro. Quello che postgrest-js consegna al
 * codice applicativo diventa `{ error: { message: 'SupabaseTimeoutError: …', hint: 'Request was
 * aborted (timeout or manual cancellation)', … }, status: 0 }` — cioè un `{ error }` normale,
 * che ogni chiamante già controlla (AGENTS, regola 7). Degrada pulito, non lancia.
 *
 * La riga di log, invece, la scrive `erroreTimeout` con `code: 'timeout'`: è la colonna
 * `app_log.codice`, quella su cui si interroga («quante scadenze oggi»), e un `ABORT_ERR` lì
 * dentro rimetterebbe insieme due guasti che si riparano in modi opposti.
 */
function abortDaScadenza(tetto: number | null, msTrascorsi: number, causa: unknown): Error {
    const err = new Error(fraseScadenza('da Supabase', tetto, msTrascorsi), { cause: causa });
    err.name = NOME_SCADENZA;
    Object.assign(err, { code: 'ABORT_ERR' });
    return err;
}

/**
 * Il nome che marchia le nostre scadenze, in un posto solo.
 *
 * Non è cosmesi: `eScadenzaSupabase` lo cerca dall'altro capo — dentro l'`{ error }` che
 * postgrest-js consegna al codice applicativo — e due letterali uguali in due file diversi sono
 * la premessa di un riconoscimento che smette di funzionare senza che nessun test lo dica.
 */
const NOME_SCADENZA = 'SupabaseTimeoutError';

/**
 * QUELL'`{ error }` È UNA SCADENZA NOSTRA?
 *
 * PostgREST non lancia: consegna `{ error: { message: 'SupabaseTimeoutError: …', hint: 'Request
 * was aborted…' }, status: 0 }` (AGENTS.md, regola 7). Chi degrada su quell'errore deve poter
 * distinguere **«il bersaglio non ha risposto in tempo»** da **«il bersaglio ha risposto un
 * errore»**: si riparano in modi opposti — la prima alzando il tetto o guardando la latenza, la
 * seconda leggendo il codice PostgREST — e senza questa distinzione finiscono nella stessa riga
 * di log con lo stesso livello.
 *
 * ⚠️ Il `code` NON serve a riconoscerla: su questa strada postgrest-js consegna `code: ''`
 * (misurato in produzione il 2026-08-05, colonna `error_code` vuota su tutte le righe). Resta
 * il nome, che è nostro e che `NOME_SCADENZA` tiene in un posto solo.
 */
export function eScadenzaSupabase(errore: unknown): boolean {
    try {
        const messaggio = (errore as { message?: unknown } | null | undefined)?.message;
        return typeof messaggio === 'string' && messaggio.startsWith(NOME_SCADENZA);
    } catch {
        return false;
    }
}

async function registraFallimento(b: Descrizione, res: Response, ms: number): Promise<void> {
    const s = stato(res) ?? 0;
    if (verràRitentato(b, s)) return;

    // Il corpo si legge SOLO qui, mai sulle risposte ok: `storage.download()` passa da questo
    // wrapper, e leggerne il corpo distruggerebbe lo streaming e farebbe esplodere la memoria.
    const err = leggeIlCorpo(b.area) ? await erroreDalCorpo(res, s) : undefined;
    const livello = livelloDi(b.area, s, err);

    logEvento(b.area, livello, campiDi(b, { stato: s, ms }), err, {
        persisti: daPersistere(livello, b.area, s),
    });
}

/**
 * Una risposta di cui non si è potuto leggere l'esito. Non si dichiara un guasto — il corpo non
 * si tocca, e il chiamante riceve la sua risposta intatta — ma nemmeno un successo: `warn`, con
 * l'esito NOMINATO, così che in `app_log` si distingua da un fallimento vero e si possa contare
 * nel tempo. Vedi `esitoDi`: è il terzo stato che prima non aveva una casella.
 */
function registraIlleggibile(b: Descrizione, res: Response, ms: number): void {
    const s = stato(res);
    logEvento(b.area, 'warn', campiDi(b, { stato: s, ms, esito: 'esito-illeggibile' }), undefined, {
        persisti: daPersistere('warn', b.area, s ?? 0),
    });
}

/**
 * Una risposta OK ma lenta. Non è un guasto di nessuno: è latenza, e si guarda su Vercel.
 *
 * Il contatore si incrementa SEMPRE, anche quando la riga non esce: è ciò che rende la scala
 * una scala invece di un troncamento — la riga alla 10ª dice `lente=10` perché le nove di mezzo
 * sono state contate, non ignorate.
 */
function registraLenta(b: Descrizione, res: Response, ms: number): void {
    const n = contaLenta();
    if (n !== undefined && !SOGLIE_LENTE.has(n)) return;
    logEvento(b.area, 'info', campiDi(b, { stato: stato(res), ms, lenta: true, lente: n }),
        undefined, { persisti: false });
}

/** Quante risposte lente ha già prodotto QUESTA richiesta. `undefined` = fuori da una richiesta. */
function contaLenta(): number | undefined {
    try {
        const c = contesto();
        if (!c) return undefined;
        const stato = lentePerRichiesta.get(c) ?? { n: 0 };
        stato.n++;
        lentePerRichiesta.set(c, stato);
        return stato.n;
    } catch {
        // Il tetto è un'ottimizzazione dell'osservabilità: se salta, si emette come prima.
        return undefined;
    }
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
 * CHI VA IN TABELLA. Due regole, e la prima è nuova (2026-08-01).
 *
 * 1. GLI `info` DI QUESTO MODULO NON SI PERSISTONO MAI. Sono, tutti, non-guasti ad alto volume:
 *    una risposta lenta, un 3xx, un `.single()` a zero righe, una credenziale sbagliata verso
 *    GoTrue. Erano fuori dalla tabella soltanto perché nessuna delle cinque aree era in
 *    `EVENTI_PERSISTITI` — una garanzia che nessuno aveva scritto e che infatti è caduta appena
 *    `storage` è entrato in allowlist (per far arrivare in tabella il successo del caricamento
 *    di un allegato, che è tutt'altra cosa). Da quel momento ogni lettura lenta dello Storage si
 *    sarebbe scritta in `app_log`, in silenzio. Una regola implicita non è una regola: è
 *    un'abitudine che regge finché nessuno la contraddice.
 *
 * 2. Un 5xx di PostgREST non si scrive sul database che lo ha appena prodotto (sotto).
 */
function daPersistere(livello: Livello, area: Bersaglio['area'], s: number): boolean {
    if (livello === 'info') return false;
    return persistibile(area, s);
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

/**
 * Tre stati, non due: `ok`, `ko`, e «non l'ho potuto leggere».
 *
 * Il terzo esisteva già nei fatti — `res.ok` può lanciare (getter ostile, Response esotica) —
 * ma veniva fatto ricadere su `ok` con la motivazione «non si inventa un guasto». Astenersi
 * dall'inventare un guasto è giusto; il difetto era la conseguenza, perché in QUESTO modulo il
 * ramo del successo è il SILENZIO: la richiesta usciva senza nessuna riga, e «tutto ok» e «non
 * so com'è andata» diventavano indistinguibili — l'ambiguità che AGENTS.md §5 vieta.
 *
 * È la stessa forma che in `withRoute` ha prodotto 73 righe `KV_OK` su altrettante richieste
 * finite in 500 (quinto collaudo, R3·R7·R12·R16·R24) e che in `externalFetch` emetteva il
 * battito di successo di un evento critico. Terza strada, stessa regola: il valore di ritorno
 * NON cambia — la risposta arriva al chiamante intatta, e non tocca al logger far riprovare
 * nessuno — ma la riga esiste e dice quello che sa.
 */
function esitoDi(res: Response): 'ok' | 'ko' | 'illeggibile' {
    try {
        return res.ok === true ? 'ok' : 'ko';
    } catch {
        return 'illeggibile';
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
