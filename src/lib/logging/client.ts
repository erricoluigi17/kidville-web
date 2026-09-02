import { redigiPath, redigiPathNelTesto, redigiPathSicuro } from './path';

/**
 * Logger del BROWSER e della WebView nativa (iOS/Android via Capacitor).
 *
 * PERCHÉ ESISTE. Metà dell'app gira dove Vercel non vede niente: un `TypeError` dentro un
 * `useEffect`, una promise rifiutata da uno dei ~249 `.catch(() => {})` del repo, una fetch
 * che muore sulla rete mobile di un genitore. Oggi tutto questo finisce nella console di un
 * dispositivo che nessuno di noi terrà mai in mano. `/api/logs` è l'unico modo di saperlo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LE SEI REGOLE (ognuna ha già un modo noto di essere violata):
 *
 *  1. NIENTE `'use client'` e NESSUN accesso a `window` a livello di MODULO. I moduli client
 *     vengono valutati anche SUL SERVER durante il prerender: un `window.fetch` a module-scope
 *     non è un bug a runtime, è `npm run build` che fallisce. Tutto ciò che tocca il DOM sta
 *     dentro `installaLoggerClient()`, che parte solo dal browser.
 *     (Per lo stesso motivo l'unico import ammesso qui è `./path`: non importa niente, quindi
 *     non trascina `node:crypto` — che è ciò che rende `redact.ts` incaricabile nel browser.)
 *
 *  2. IL FLUSH NON PASSA DA `fetch`. Si usa `navigator.sendBeacon`. Non è un'ottimizzazione:
 *     è ciò che rende il LOOP INFINITO impossibile PER COSTRUZIONE. Con una `fetch` normale,
 *     il patch qui sotto vedrebbe la richiesta di invio dei log, e se quella fallisse (rete
 *     giù — cioè proprio il caso in cui i log servono) genererebbe un log, che genererebbe una
 *     fetch, che… Il fallback usa il fetch ORIGINALE, catturato PRIMA del patch, mai
 *     `window.fetch`: quello è patchato, e il ciclo tornerebbe dalla finestra.
 *
 *  3. IL PATCH DI `fetch` NON LEGGE MAI I BODY. Vede anche `POST /auth/v1/token`, cioè le
 *     PASSWORD dei genitori in chiaro, e gli upload di certificati medici. Si loggano metodo,
 *     pathname e status: nient'altro. Nessun `.clone()`, nessuna ricostruzione della Request —
 *     gli argomenti passano INTATTI (ricostruirli romperebbe upload e streaming).
 *
 *  4. NESSUN PATH GREZZO ESCE DA QUESTO DISPOSITIVO. In questo repo il path è una CREDENZIALE:
 *     il token del modulo pubblico è un SEGMENTO di path (`/m/<token>`), non un query param, e
 *     dà accesso al modulo di preiscrizione di un minore. Il `messaggio` di un evento del
 *     client finisce in `app_log.messaggio` — 30 giorni, interrogabile in SQL — e nessuna
 *     difesa del server lo riduce a pattern: `sanificaMessaggio` maschera email e codici
 *     fiscali, non i path. Perciò la riduzione si fa QUI, alla fonte: `logClient` è il
 *     collo di bottiglia da cui passa ogni evento, e ci applica `redigiPathNelTesto`.
 *     (`/api/logs` la rifà comunque server-side, difesa in profondità — vedi lì il perché:
 *     un client vecchio o modificato continuerà a spedire path grezzi per mesi.)
 *
 *  5. UN 401 NON È UN GUASTO. Il livello di un `!res.ok` segue la STESSA politica di
 *     `with-route.ts` — vedi `livelloFetch`. Non è una scelta estetica: `/api/logs` chiama
 *     `appLog` DIRETTAMENTE, quindi tutto ciò che gli arriva viene PERSISTITO, senza passare
 *     da `vaPersistito`. Un `error` spedito da qui è una riga in tabella, punto.
 *
 *  6. NON LANCIA MAI. Un bug dell'osservabilità non può diventare un bug del prodotto: qui
 *     significherebbe rompere `fetch` per l'INTERA applicazione. Ogni ramo è avvolto, e il
 *     ramo di fallimento restituisce sempre la chiamata originale.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Il sink. `startsWith` su questa costante è ciò che impedisce al patch di vedere sé stesso. */
const SINK = '/api/logs';

/**
 * Coda corta di proposito. Il batch massimo accettato da `/api/logs` è 20: una coda più
 * lunga produrrebbe richieste che il server tronca — cioè log che il client crede di aver
 * spedito e che non esistono. I due numeri devono restare uguali.
 */
const CODA_MAX = 20;

/**
 * ANTI-TEMPESTA. Una WebView su rete mobile degradata produce lo STESSO errore decine di
 * migliaia di volte in un'ora (un `syncEngine` che ritenta, un componente che rimonta in
 * loop). Senza throttle si spedirebbero decine di migliaia di righe per dire una cosa sola,
 * e il rate-limit di `/api/logs` chiuderebbe la porta proprio mentre arriva l'errore NUOVO —
 * quello che si voleva vedere. La deduplica in tabella (`fingerprint`) è la seconda rete, non
 * la prima: quel che va evitato è il TRAFFICO, non solo il volume delle righe.
 */
const DEDUP_MS = 60_000;

/**
 * Tetto delle chiavi ricordate dal throttle. Senza, `visti` cresce senza fine su una SPA che
 * resta aperta tutto il giorno (l'app dei docenti sta aperta l'intera mattinata) e ogni errore
 * con un id diverso nel messaggio è una chiave nuova: una perdita di memoria dentro il modulo
 * che serve a scoprire le perdite di memoria.
 */
const VISTI_MAX = 100;

/** Cap allineati a quelli di `/api/logs` (zod) e della RPC: si tronca prima di spedire. */
const MESSAGGIO_MAX = 500;
const STACK_MAX = 4_000;
const ROUTE_MAX = 200;

const CHIAVE_CODA = 'kv_log_coda';

/**
 * L'identità, dalla stessa fonte che usa tutto il resto dell'app (`kv_user_id`, scritto al
 * login). Non è un capriccio: `sendBeacon` NON può mandare header, quindi `x-user-id` — il
 * canale con cui le pagine passano l'identità alle route — qui non è disponibile. Resta il
 * query param `?userId=`, che è l'altra metà di `getRequestUserId()` lato server. Senza,
 * OGNI riga del client sarebbe anonima e la domanda operativa vera ("a quanti utenti è
 * successo?", "è successo solo a lui?") non avrebbe risposta.
 */
const CHIAVI_IDENTITA = ['kv_user_id', 'kv_parent_id'];

/**
 * Header con cui Next marca le PROPRIE chiamate interne: prefetch RSC, Server Action, HMR.
 * Un'app App Router ne fa a decine per pagina; senza queste esclusioni i log del client
 * sarebbero un elenco di prefetch, e l'errore vero sarebbe una riga su cento.
 */
const HEADER_NEXT = [
    'rsc',
    'next-action',
    'next-router-state-tree',
    'next-router-prefetch',
    'next-router-segment-prefetch',
    'next-hmr-refresh',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nessun evento nasce senza messaggio, e non è pignoleria: `/api/logs` valida con
 * `z.string().min(1)`, e un `Promise.reject(new Error())` — che il listener
 * `unhandledrejection` traduce in `messaggio: ''` — basta a far scartare quell'evento.
 * Il messaggio vuoto non dice niente di suo, ma l'evento SÌ (quale pagina, quale tipo,
 * quale stato): si tiene l'evento e si dichiara ciò che manca, invece di perderlo.
 */
const SENZA_MESSAGGIO = '[senza-messaggio]';

/**
 * I 4xx che NON sono rumore. È la stessa lista di `ANOMALIE_4XX` in `with-route.ts`, e deve
 * restare la stessa: le due politiche descrivono LO STESSO evento visto dai due lati (il
 * server che risponde, il client che riceve), e se divergessero lo stesso 401 uscirebbe dal
 * server come `info` — fuori dalla tabella — e vi rientrerebbe dal browser come `error`.
 */
const ANOMALIE_4XX = new Set([408, 409, 413, 429]);

/**
 * Il livello di un `!res.ok`, o `null` per «non si spedisce affatto».
 *
 * PERCHÉ NON SI LOGGA TUTTO. Il patch vede OGNI fetch, comprese quelle verso Supabase: una
 * sessione scaduta (401) e una password sbagliata al login (400 su `/auth/v1/token`) sono
 * risposte CORRETTE a richieste sbagliate, e capitano a ogni utente ogni giorno. Spedirle a
 * livello `error` significherebbe una riga in `app_log` per ognuna — la tabella di rumore in
 * cui gli errori veri non si trovano più, che è esattamente ciò che `with-route.ts` si dà la
 * pena di tenere FUORI (vedi la sua "POLITICA DEI LIVELLI": 401/403/404 → `info`, mai in
 * tabella). Da qui non si può replicare quel `info`, perché lo schema di `/api/logs` ammette
 * solo `warn|error` e la route persiste TUTTO ciò che riceve: l'unico modo di dire «non
 * conservarlo» è NON SPEDIRLO.
 *
 * Ciò che si perde è visibile altrove: il server quei 4xx li vede e li logga su Vercel. Ciò
 * che invece SOLO il client vede — la fetch che non è mai partita (rete giù, DNS, CORS) — ha
 * `stato: 0` e resta il motivo per cui questo patch esiste; il suo livello è `warn` e non
 * `error`, per la ragione misurata nella testata di `eAnnullata`.
 *
 * `stato < 400` (una 3xx non seguita, una risposta opaca con `status: 0`) → `null`: non è un
 * guasto, e una risposta opaca non ha nemmeno uno status da raccontare.
 */
function livelloFetch(stato: number): 'warn' | 'error' | null {
    if (stato >= 500) return 'error';
    if (ANOMALIE_4XX.has(stato)) return 'warn';
    return null;
}

/**
 * IL LIVELLO CON CUI UN EVENTO LASCIA IL DISPOSITIVO — e perché non lo decide chi chiama.
 *
 * ─── IL FATTO (rilievo Q7, quarto collaudo) ─────────────────────────────────
 *
 * `livelloFetch` governava il solo patch di `fetch`. Ma `logClient` è ESPORTATA, e i
 * componenti che la chiamano direttamente per dire «l'invio è stato respinto» cablavano
 * `livello: 'error'` per qualunque `!res.ok`. Risultato misurato dalla UI vera: lo stesso
 * rifiuto — un genitore che sceglie un giorno passato — usciva `warn` dal server e rientrava
 * `error` dal browser. Due livelli per lo stesso evento, visto dai due lati.
 *
 * Non è un dettaglio di etichetta: `/api/logs` persiste tutto ciò che riceve, l'impronta di
 * `app_log` include l'utente, e `controlloTassoErrore` dichiara `/api/health` degradato a 5
 * impronte `error` distinte in 15 minuti. Sei famiglie che sbagliano giorno nella stessa
 * finestra bastavano a far dire «degradato» a un'applicazione sana.
 *
 * ─── PERCHÉ LA REGOLA STA QUI E NON NEI COMPONENTI ──────────────────────────
 *
 * Perché era già scritta due volte (qui e in `with-route.ts`) e una terza copia in un
 * componente è il modo in cui le tre divergono. `logClient` è il collo di bottiglia da cui
 * passa OGNI evento — è la stessa ragione per cui ci sta dentro `redigiPathNelTesto`: quello
 * che vale per la funzione non può dipendere dalla disciplina di chi scriverà il prossimo
 * chiamante.
 *
 * ─── IL CONFINE, che è la parte da non sbagliare ────────────────────────────
 *
 * La politica si applica SOLO a uno status di RISPOSTA (400–599). `stato: 0` non è una
 * risposta: è la fetch che non è mai partita, e il suo livello (`warn`) è una decisione
 * separata e misurata — vedi la testata di `eAnnullata`. Applicargli `livelloFetch`
 * significherebbe sopprimere l'unica traccia possibile di un'interruzione di rete, che il
 * server per definizione non vede. Gli eventi senza `stato` (`js`, `react`, `offline`) non
 * hanno niente da giudicare: il livello resta di chi li emette.
 */
function livelloEvento(e: EventoClient): 'warn' | 'error' | null {
    const dichiarato: 'warn' | 'error' = e.livello === 'warn' ? 'warn' : 'error';
    try {
        const stato = e.stato;
        if (typeof stato !== 'number' || !Number.isInteger(stato)) return dichiarato;
        if (stato < 400 || stato >= 600) return dichiarato;
        return livelloFetch(stato);
    } catch {
        // Getter ostile su un oggetto evento: si tiene ciò che il chiamante ha dichiarato.
        return dichiarato;
    }
}

/**
 * LA FETCH CHE NON È MAI PARTITA — e perché non è più un `error`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL RUMORE, MISURATO. In `app_log`, su trenta giorni, **763 occorrenze su 964** del canale
 * client sono `stato_http = 0` a livello `error`: il 79%. La sola riga
 * «GET /api/notifiche — Failed to fetch» ne conta 372. E sotto a quella montagna stavano
 * 41 occorrenze in UN giorno di `POST /api/iscrizione/upload → 413`: genitori che non
 * riuscivano ad allegare i documenti al modulo pubblico. Il guasto vero era a livello
 * `warn`, il rumore a livello `error`: chi apriva la tabella filtrando per `error` — cioè
 * chiunque — vedeva solo il rumore.
 *
 * PERCHÉ `stato: 0` NON È UN GUASTO. Questa app gira in una WebView Capacitor. Lì
 * «Failed to fetch» (Chrome/Android) e «Load failed» (Safari/iOS) sono ciò che il motore
 * dice quando la richiesta viene TRONCATA: l'utente cambia pagina, il telefono si
 * addormenta, l'app va in background mentre un polling è in volo. A livello di JavaScript
 * è indistinguibile dalla rete caduta davvero — non c'è nessun campo che le separi — e
 * fra le due la frequente, di gran lunga, è la prima.
 *
 * PERCHÉ NON SI BUTTA. Resta l'unica traccia possibile di un'interruzione di rete vera: la
 * richiesta non è mai arrivata al server, quindi nessun log del server la vedrà mai. Si
 * declassa a `warn` — che è persistito e contabile — invece di sopprimerla: il livello
 * dice «capita, guardalo quando ne conti troppi», che è esattamente ciò che è.
 *
 * L'ECCEZIONE È L'ABORT, e va nella direzione opposta: `AbortError` lo produce il NOSTRO
 * codice (un `AbortController` allo smontaggio, un timeout applicativo). Non si spedisce
 * affatto — sarebbe una riga per dire «ho fatto ciò che ho deciso di fare». Il livello che
 * gli spetterebbe (`info`) la route `/api/logs` non lo accetta, quindi l'unico modo di
 * dire «non conservarlo» è non spedirlo, come per i 401.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
function eAnnullata(err: unknown): boolean {
    try {
        // `name`, non `instanceof DOMException`: nelle WebView e sotto jsdom la classe non è
        // sempre la stessa, ma il nome è quello che la specifica fetch impone.
        return (err as { name?: unknown } | null | undefined)?.name === 'AbortError';
    } catch {
        // Getter ostile: nel dubbio la si tratta come una fetch fallita e la si logga.
        return false;
    }
}

/**
 * Gli eventi che il server accetta. Tenerli qui non serve a difendere il server (che si
 * difende da sé: è la porta ostile), serve a non scoprire in produzione che una riga di log
 * è stata scartata con un 400 perché il nome dell'evento era `errore-js` invece di `js`.
 */
export type EventoNome = 'js' | 'unhandledrejection' | 'fetch' | 'react' | 'offline' | 'biometria' | 'push' | 'avvio' | 'accesso';

export interface EventoClient {
    livello: 'warn' | 'error';
    evento: EventoNome;
    messaggio: string;
    stack?: string;
    /** La rotta della PAGINA (non della fetch): è il luogo dell'incidente. */
    route?: string;
    stato?: number;
    /** Il `digest` di Next: l'unica chiave che lega un errore del client al suo stack server. */
    digest?: string;
}

/* Stato di modulo. NON è contaminabile fra utenti: nel browser il modulo è per-scheda. */
let coda: EventoClient[] = [];
const visti = new Map<string, number>();
let installato = false;
/** Il fetch di PRIMA del patch. È il solo che il fallback di `flush` può usare (regola 2). */
let fetchOriginale: typeof fetch | null = null;

/**
 * La piattaforma su cui gira il codice. SI CHIEDE AL BRIDGE, NON SI INDOVINA.
 *
 * IL DIFETTO, misurato in produzione il 2026-09-01. Questa funzione decideva
 * annusando la stringa `Capacitor` nello user-agent — e Capacitor quella stringa
 * NON la scrive: `appendUserAgent` è una configurazione facoltativa e in questo
 * repo non è impostata, né in `capacitor.config.ts` né nei config generati per
 * Android e iOS. Su 1.722 righe e 3.625 occorrenze di eventi client in 31 giorni,
 * `piattaforma` diceva `web` per tutte tranne UNA, e quell'una era un payload
 * sintetico del collaudo dell'08/08. Zero dispositivi nativi veri, mai.
 *
 * LA PROVA che erano eventi nativi: `scegliFotoNativa` (`@/lib/native/camera`)
 * esce PRIMA del `try` quando non siamo nella shell, quindi sul web non può
 * loggare niente — eppure i suoi `fotocamera-errore` risultavano tutti `web`. Due
 * rilevazioni che si contraddicevano; quella che mentiva era l'indovinello.
 *
 * Non è costato un errore in più: è costato ogni domanda del tipo «succede solo
 * su Android?», rimasta senza risposta per un mese senza che si vedesse — una
 * colonna piena di `web` sembra una misura invece che un silenzio.
 *
 * `globalThis.Capacitor` e non un `import`: la REGOLA 1 di questo file vieta
 * qualunque import oltre a `./path`. Il bridge nativo si espone sul globale, ed è
 * la stessa fonte che interroga `isNativeApp()`.
 */
function piattaforma(): 'web' | 'ios' | 'android' {
    try {
        const bridge = (globalThis as { Capacitor?: { getPlatform?: () => unknown } }).Capacitor;
        const dichiarata = typeof bridge?.getPlatform === 'function' ? bridge.getPlatform() : null;
        // Solo i tre valori che la colonna contempla: una shell futura che dicesse
        // «electron» non deve poter scrivere una quarta parola che nessuna query
        // si aspetta.
        if (dichiarata === 'ios' || dichiarata === 'android') return dichiarata;
        if (dichiarata === 'web') return 'web';

        // RIPIEGO, per la finestra in cui il bridge non è ancora installato. Da solo
        // non bastava — è il difetto qui sopra — ma se un giorno `appendUserAgent`
        // venisse configurato, questo ramo lo raccoglie invece di ignorarlo.
        const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
        if (!/Capacitor/i.test(ua)) return 'web';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
        if (/Android/i.test(ua)) return 'android';
        return 'web';
    } catch {
        return 'web';
    }
}

function tronca(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max);
}

/**
 * La forma di un nome di classe d'errore: `Error`, `TypeError`, `AbortError`, `DOMException`,
 * `PostgrestError`, `ZodError`, `ERR_NETWORK`. Niente spazi, niente punteggiatura, niente
 * accenti — cioè niente di ciò che ha la forma del TESTO.
 */
const NOME_ERRORE_RX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * L'UNICO pezzo di un errore che può lasciare il dispositivo.
 *
 * PERCHÉ ESISTE. Nel client questo repo aveva ~35 righe `console.error('Errore X:', err)`.
 * `err` lì è quasi sempre un errore PostgREST o una `Error` costruita dal server, e il suo
 * `.message` riecheggia filtri, colonne e valori: `alunno_id=eq.<uuid>`, «studenti per classe
 * Primavera A», «CF non valido per Mario Rossi». Nessuna whitelist lo guardava, perché
 * `console` non passa da `redact()` — e quei log finivano nella console di un telefono, cioè
 * in un posto dove nessuno li avrebbe mai letti e da cui chiunque avrebbe potuto leggerli.
 *
 * Il `.name` invece è STRUTTURA, non contenuto: lo decide la classe, non il dato. E porta
 * l'unica distinzione che serve davvero al triage — `TypeError` (la rete è giù: il genitore è
 * in metropolitana) contro `Error` (il server ha risposto e ha detto di no: è un nostro bug).
 *
 * Non lancia mai: la chiamano dei `catch`, ed è l'ultimo posto in cui si può permettere di
 * aprire una seconda eccezione (un getter `name` ostile esiste, e in jsdom è banale da avere).
 */
export function nomeErrore(e: unknown): string {
    try {
        if (!(e instanceof Error)) return 'errore';
        const nome = e.name;
        if (typeof nome !== 'string' || !NOME_ERRORE_RX.test(nome)) return 'errore';
        return nome;
    } catch {
        return 'errore';
    }
}

/**
 * Accoda un evento. NON LANCIA MAI: è chiamata da `window.onerror`, cioè dal gestore che si
 * attiva quando l'app è GIÀ rotta — è l'ultimo posto del sistema in cui ci si può permettere
 * di sollevare una seconda eccezione.
 */
export function logClient(e: EventoClient): void {
    accoda(e, true);
}

/**
 * L'evento che il logger scrive SU SÉ STESSO, e che non passa dalla politica dei livelli.
 *
 * Esiste per un caso solo, ed è quello in cui la politica sarebbe esattamente sbagliata:
 * `/api/logs` che risponde 400 e scarta un batch. Lì lo `stato` non è «una risposta che l'app
 * ha ricevuto e che il server ha già registrato per conto suo»: è il canale dei log che si è
 * rotto, e quella riga è l'unica che possa dirlo. Sopprimerla perché «400 è un rifiuto
 * ordinario» significherebbe perdere in silenzio proprio la notizia che i log si stanno
 * perdendo in silenzio.
 *
 * NON è esportata, e non deve diventarlo: la deroga vale per il modulo che parla di sé, non
 * per i componenti — che è tutto il punto di Q7.
 */
function logClientInterno(e: EventoClient): void {
    accoda(e, false);
}

function accoda(e: EventoClient, applicaPolitica: boolean): void {
    try {
        // LA POLITICA DEI LIVELLI, PRIMA DI TUTTO IL RESTO (vedi `livelloEvento`): un rifiuto
        // ordinario del server non si spedisce affatto — quei 4xx il server li vede e li logga
        // già, con il codice in colonna. Prima del throttle, così un evento che non parte non
        // occupa nemmeno una chiave di `visti`.
        const livello = applicaPolitica ? livelloEvento(e) : (e.livello === 'warn' ? 'warn' : 'error');
        if (livello === null) return;

        // `redigiPathNelTesto` QUI e non nei chiamanti, per lo stesso motivo per cui
        // `impostaPayload` redige da sé invece di fidarsi delle 239 route: questo è l'UNICO
        // punto da cui passa ogni evento, e un evento può nascere ovunque — dal patch di
        // `fetch`, da `window.onerror`, da una boundary React, da un `error.tsx` di domani.
        // Ridurre solo nel patch di `fetch` coprirebbe il caso che già conosciamo e lascerebbe
        // scoperti tutti gli altri: il messaggio di un `TypeError` contiene benissimo l'URL
        // («Failed to fetch https://app.kidville.it/m/<token>»), e quel token è una credenziale.
        // È idempotente: `/m/[tok]` ripassato di qui resta `/m/[tok]`.
        const messaggio = tronca(redigiPathNelTesto(String(e.messaggio ?? '')), MESSAGGIO_MAX)
            || SENZA_MESSAGGIO;

        // La chiave del throttle NON include la `route`: lo stesso errore su venti pagine
        // diverse è lo stesso errore (ed è così che si scopre che è globale, non di una
        // pagina). Include invece lo `stato`: `→ 500` e `→ 401` sono due guasti diversi.
        const chiave = `${e.evento}|${messaggio}|${e.stato ?? ''}`;
        const ora = Date.now();
        const ultimo = visti.get(chiave);
        if (ultimo !== undefined && ora - ultimo < DEDUP_MS) return;
        // `delete` + `set`: rimette la chiave in fondo all'ordine di inserimento della Map,
        // così lo sfratto qui sotto butta la MENO RECENTE e non una a caso.
        visti.delete(chiave);
        visti.set(chiave, ora);
        if (visti.size > VISTI_MAX) {
            const piuVecchia = visti.keys().next();
            if (!piuVecchia.done) visti.delete(piuVecchia.value);
        }

        // Coda piena: si butta il PIÙ VECCHIO. In una tempesta i primi errori sono cause e gli
        // ultimi conseguenze — ma i primi sono anche già passati dal throttle e quindi
        // probabilmente già spediti, mentre l'ultimo arrivato è l'unico che nessuno ha visto.
        if (coda.length >= CODA_MAX) coda.shift();

        coda.push({
            livello,
            evento: e.evento,
            messaggio,
            stack: e.stack === undefined ? undefined : tronca(String(e.stack), STACK_MAX),
            // `logClient` è ESPORTATA: la chiamano le boundary React (`error.tsx`), che la
            // `route` se la costruiscono da sé. Il server la ridurrebbe comunque (`appLog` →
            // `redigiPath`), ma la regola 4 dice che dal dispositivo non esce un path grezzo:
            // vale anche per chi passa di qui dall'esterno, non solo per `pagina()`.
            //
            // ⚠️ IL RIPIEGO È `pagina()`, E NON `undefined`. Misurato in produzione il
            // 2026-08-04: 60 righe `sorgente='client'` su 309 portavano `route='/api/logs'`, e
            // nessuna di quelle era un guasto del logger (il patch di `fetch` esclude il
            // proprio SINK: non può generarle). Erano i 62 punti di chiamata del repo che la
            // `route` non la passano — `modulo-allegato-upload-fallito`, `sw-senza-controllo`,
            // `iscrizione-sedi-non-caricate`. Lasciandola `undefined` il campo NON resta vuoto:
            // lato server `app-log.ts → rotta()` ripiega sul `contesto().path`, che per un log
            // del browser vale sempre `/api/logs` — il nome del CAMION, non del luogo
            // dell'incidente, cioè l'unica pagina in cui quell'errore non è mai avvenuto.
            // La pagina la sa SOLO il client, e questo è l'ultimo punto in cui la sa ancora.
            //
            // `|| pagina()` e non `?? pagina()`: una `route: ''` è una rotta non dichiarata, e
            // una stringa vuota in tabella mente esattamente come `/api/logs`. Il `|| undefined`
            // finale è il caso in cui NEMMENO la pagina si legge (prerender, worker, `location`
            // negata): lì il campo si lascia mancante, che è la verità — non si inventa un `''`.
            // `redigiPathSicuro` resta sopra a tutto: `pagina()` riduce già da sé, ma la
            // riduzione qui è idempotente e vale anche per la route che arriva dall'esterno.
            route: tronca(redigiPathSicuro(e.route || pagina()), ROUTE_MAX) || undefined,
            stato: typeof e.stato === 'number' && Number.isInteger(e.stato) ? e.stato : undefined,
            digest: e.digest === undefined ? undefined : tronca(String(e.digest), 64),
        });
        salvaCoda();
    } catch {
        // Fail-open: si perde il log, non l'app.
    }
}

/**
 * CODA PERSISTITA. Serve a un caso che nessun altro meccanismo copre: `syncEngine` gira
 * OFFLINE, e i suoi errori (Dexie/IndexedDB) non passano né dal patch di `fetch` — non c'è
 * nessuna fetch — né da una boundary React. Se la scheda viene chiusa prima che torni la rete,
 * quei log muoiono con lei: cioè proprio i bug del percorso offline, che sono quelli che non
 * riusciremmo a riprodurre in nessun altro modo. Il `localStorage` sopravvive alla chiusura;
 * `flush()` li ritrova al prossimo avvio.
 */
/**
 * La copia persistita RISPECCHIA SEMPRE la coda in memoria — non è un archivio a parte.
 *
 * Da qui la cancellazione quando la coda è vuota (invece di un `removeItem` sparso nei rami di
 * `flush`): dopo una spedizione riuscita si chiama `salvaCoda()` e basta. Sembra un dettaglio
 * ed è un bug evitato: `flush` è ASINCRONO nel ramo di fallback, e fra la partenza della
 * richiesta e la sua risposta possono essere arrivati eventi NUOVI. Un `removeItem` cieco alla
 * fine li cancellerebbe — cioè si perderebbero proprio i log nati durante il guasto.
 */
function salvaCoda(): void {
    try {
        if (coda.length === 0) {
            localStorage.removeItem(CHIAVE_CODA);
            return;
        }
        localStorage.setItem(CHIAVE_CODA, JSON.stringify(coda.slice(-CODA_MAX)));
    } catch {
        // Quota piena, storage negato (Safari in privata), o `localStorage` inesistente in una
        // WebView vecchia. Si perde la persistenza, non la coda in memoria: il flush di questa
        // sessione parte lo stesso.
    }
}

/**
 * Rimette in coda ciò che non è partito, e lo fa SOPRAVVIVERE alla chiusura della scheda.
 * Chiamata da ogni ramo in cui la spedizione non è andata: un log che si perde in silenzio è
 * il guasto che questo sistema esiste per impedire.
 */
function rimettiInCoda(inviati: EventoClient[]): void {
    coda = [...inviati, ...coda].slice(-CODA_MAX);
    salvaCoda();
}

function riprendiCoda(): void {
    try {
        const raw = localStorage.getItem(CHIAVE_CODA);
        if (!raw) return;
        const salvata: unknown = JSON.parse(raw);
        // Il `localStorage` è scrivibile da chiunque abbia la console aperta: ciò che si
        // rilegge non è più fidato di un input di rete. Si tiene solo ciò che ha la forma
        // giusta, e `conMessaggio` ripara l'unico campo il cui vuoto costerebbe l'evento
        // (`z.string().min(1)` lo scarterebbe lato server).
        if (!Array.isArray(salvata)) return;
        coda = [...salvata.filter(eventoPlausibile).map(conMessaggio), ...coda].slice(-CODA_MAX);
    } catch {
        // JSON corrotto: si riparte con la coda vuota.
    }
}

function eventoPlausibile(v: unknown): v is EventoClient {
    if (v === null || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return (e.livello === 'warn' || e.livello === 'error')
        && typeof e.evento === 'string' && e.evento !== ''
        && typeof e.messaggio === 'string';
}

/** Un evento riletto dallo storage non deve poter far scartare sé stesso (vedi `SENZA_MESSAGGIO`). */
function conMessaggio(e: EventoClient): EventoClient {
    return e.messaggio === '' ? { ...e, messaggio: SENZA_MESSAGGIO } : e;
}

/** L'id utente, se il login l'ha lasciato dove lo lascia sempre. Mai altro che un uuid. */
function identita(): string | null {
    try {
        for (const k of CHIAVI_IDENTITA) {
            const v = localStorage.getItem(k);
            if (v !== null && UUID.test(v)) return v;
        }
    } catch {
        // Storage negato: la riga resterà anonima, che è la verità.
    }
    return null;
}

/**
 * Gli stati per cui RITENTARE ha senso: il batch è valido, è il server che non può accoglierlo
 * ADESSO. Un 400 o un 413, invece, quel batch li darà per sempre — rimetterlo in coda
 * significherebbe rispedire in eterno un corpo che il server rifiuta, cioè trasformare la coda
 * dei log in una tempesta che non si esaurisce mai.
 */
function ritentabile(stato: number): boolean {
    return stato >= 500 || stato === 429 || stato === 408;
}

/**
 * Spedisce la coda. Fire-and-forget: nessuno aspetta i log.
 *
 * `sendBeacon` è l'unica API che il browser garantisce di completare anche mentre la pagina
 * MUORE (`pagehide`), ed è il caso più importante che ci sia: l'errore che precede la chiusura
 * dell'app è quello che l'utente sta subendo in quel momento. Una `fetch` normale, lì, viene
 * cancellata dal browser (`keepalive` aiuta ma non è garantito ovunque, e nelle vecchie
 * WebView non c'è).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUANDO SI BUTTA VIA LA COPIA PERSISTITA, e perché i due canali si comportano diversamente.
 *
 * `sendBeacon` NON RIPORTA L'ESITO: restituisce `true` quando il browser ha ACCETTATO di
 * spedire, non quando il server ha risposto — e per costruzione non potrebbe fare altro (nasce
 * per girare mentre la pagina muore, quando non c'è più nessuno ad ascoltare una risposta). Su
 * quel canale «partita» è tutto ciò che si può sapere, e la coda si svuota lì. Il rischio è
 * noto e si accetta: se la richiesta muore in volo si perdono fino a 20 righe. L'alternativa —
 * non cancellare mai finché non arriva una conferma che non arriverà mai — è una coda che
 * cresce all'infinito e rispedisce le stesse righe a ogni evento: la tempesta al posto della
 * perdita, e per giunta con i doppioni.
 *
 * Il FALLBACK `fetch`, invece, l'esito ce l'ha — e allora si guarda, che è il punto del fix:
 * la coda persistita non si tocca finché il server non ha detto `ok`. Se risponde male o non
 * risponde affatto, le righe restano dov'erano e il prossimo `flush` (l'evento `online`, il
 * cambio pagina, il `pagehide`) le riprova.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
export function flush(): void {
    if (coda.length === 0) return;

    const inviati = coda;
    coda = [];

    try {
        const uid = identita();
        // `?userId=` e non un campo del body: l'identità la decide il SERVER
        // (`getRequestUserId`), che è l'unico che può rifiutarla. Un campo nel body sarebbe
        // un'identità dichiarata da chi la usa.
        const url = uid === null ? SINK : `${SINK}?userId=${encodeURIComponent(uid)}`;
        const corpo = JSON.stringify({ eventi: inviati, piattaforma: piattaforma() });

        const beacon = typeof navigator !== 'undefined'
            && typeof navigator.sendBeacon === 'function'
            // Il tipo È necessario: senza, il browser manda `text/plain` e il body arriva
            // come richiesta "semplice" — la route lo rifiuterebbe come JSON malformato.
            && navigator.sendBeacon(url, new Blob([corpo], { type: 'application/json' }));

        if (beacon) {
            // Affidata al browser: è tutto ciò che `sendBeacon` sa dire (vedi sopra). La copia
            // persistita torna a rispecchiare la coda IN MEMORIA — che a questo punto è vuota,
            // salvo gli eventi arrivati nel frattempo, che NON vanno cancellati.
            salvaCoda();
            return;
        }

        if (fetchOriginale === null) {
            // NESSUN CANALE: né `sendBeacon` (WebView antica) né il fetch originale (il logger
            // non è ancora installato — `logClient` è esportato e una boundary potrebbe
            // chiamarlo prima). Si rimette tutto in coda: cancellare qui significherebbe
            // buttare via dei log che non sono mai partiti, il modo più stupido di perdere un
            // guasto.
            rimettiInCoda(inviati);
            return;
        }

        // `sendBeacon` restituisce `false` quando la coda del browser è piena (o quando non
        // esiste). Si ripiega sul fetch ORIGINALE — MAI `window.fetch`, che è patchato e
        // richiamerebbe il logger su questa stessa richiesta (regola 2).
        void fetchOriginale(url, {
            method: 'POST',
            body: corpo,
            headers: { 'content-type': 'application/json' },
            keepalive: true,
        }).then((res) => {
            if (res.ok) {
                // Confermato dal server: solo ADESSO la copia persistita lascia andare queste
                // righe. (Un `res.ok` con `scartati > 0` resta un successo: la route ingerisce
                // evento per evento, quindi ciò che è stato scartato non sarebbe accettato
                // nemmeno riprovando — vedi `/api/logs`.)
                salvaCoda();
                return;
            }
            if (ritentabile(res.status)) {
                rimettiInCoda(inviati);
                return;
            }
            // Il server ha rifiutato il batch e lo rifiuterà sempre (400: il NOSTRO client ha
            // spedito qualcosa che il NOSTRO schema non accetta; 413: è troppo grosso). Le
            // righe si perdono — ma non in silenzio: si accoda un evento che lo DICE, ed è
            // l'unico modo per accorgersi che il canale dei log è rotto. Non innesca un ciclo:
            // l'evento nuovo è valido, e il throttle lo tiene a uno al minuto.
            //
            // `logClientInterno` e non `logClient`: qui lo `stato` è quello del SINK, e la
            // politica dei livelli — che per un 400 dice «non spedire, il server l'ha già
            // registrato» — sopprimerebbe l'unica riga che dice che i log si stanno perdendo.
            logClientInterno({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `POST ${SINK} → ${res.status}: batch di ${inviati.length} eventi scartato`,
                route: pagina(),
                stato: res.status,
            });
            salvaCoda();
        }).catch(() => {
            // Rete giù. I log si RIMETTONO in coda: sono proprio quelli che raccontano perché
            // la rete era giù, e buttarli qui vorrebbe dire perdere l'incidente insieme al
            // mezzo per diagnosticarlo. `salvaCoda` li fa sopravvivere alla chiusura della
            // scheda; l'evento `online` riproverà.
            rimettiInCoda(inviati);
        });
    } catch {
        // `JSON.stringify` su una coda impazzita, `Blob` assente in una WebView antica: si
        // rimette tutto in coda e si riproverà al prossimo evento. Non si perde nulla e,
        // soprattutto, non si lancia dentro un gestore di `pagehide`.
        rimettiInCoda(inviati);
    }
}

/**
 * Installa il logger: patch di `fetch`, `onerror`, `unhandledrejection`, flush sui punti in
 * cui la pagina può morire. Idempotente e SSR-safe (fuori dal browser è un no-op).
 *
 * La chiama `src/instrumentation-client.ts`, che Next esegue UNA volta, dopo il caricamento
 * del documento e PRIMA dell'hydration. Un provider React non basterebbe: gli `useEffect` del
 * padre girano DOPO quelli dei figli, quindi le fetch del primo caricamento — dove stanno i
 * guasti di avvio, che sono i peggiori — sarebbero già partite senza nessuno a guardarle.
 */
export function installaLoggerClient(): void {
    try {
        if (installato || typeof window === 'undefined') return;
        installato = true;

        riprendiCoda();

        // Catturato a RUNTIME, non al caricamento del modulo: il bridge di Capacitor gira a
        // document-start e riassegna `window.fetch` di suo. Prendendolo qui si avvolge il suo,
        // e le chiamate native continuano a funzionare; prendendolo prima lo si scavalcherebbe.
        const originale = window.fetch.bind(window);
        fetchOriginale = originale;

        window.fetch = async (input, init) => {
            /*
             * DUE FASI, e la separazione è la cosa più importante di questa funzione.
             *
             * Il modo ovvio di scriverla — un unico try che avvolge tutto, con
             * `catch { return originale(input, init) }` come rete fail-open — contiene un bug
             * grave e silenzioso: quel `catch` intercetta ANCHE il rigetto della fetch vera
             * (rete giù), e "ricadere sull'originale" lì significa RIESEGUIRE la richiesta.
             * Cioè spedire due volte lo stesso POST: un doppio pagamento, una doppia
             * iscrizione, un doppio invio di credenziali. Il logger avrebbe cambiato il
             * comportamento dell'app — l'unica cosa che ha il divieto assoluto di fare.
             *
             * Perciò: nella FASE 1 sta tutto ciò che può lanciare per colpa NOSTRA, e lì il
             * fail-open è legittimo (la richiesta non è ancora partita). Nella FASE 2 la
             * richiesta è partita, e da lì in poi non si ricade più su `originale`: si logga
             * e si rilancia l'errore così com'è.
             */

            // ── FASE 1: decidere se osservare. Nulla è ancora partito.
            let req: Request | null = null;
            let url = '';
            try {
                req = input instanceof Request ? input : null;
                url = String(req !== null ? req.url : input);
                if (daIgnorare(url, req, init)) return originale(input, init);
            } catch {
                // Un input ostile (`toString` che lancia): si rinuncia a osservare, non a fare
                // la richiesta.
                return originale(input, init);
            }

            // ── FASE 2: la chiamata vera. `input` e `init` INTATTI — ricostruire la Request
            // romperebbe upload, streaming e AbortSignal. Il logger osserva, non tocca.
            let res: Response;
            try {
                res = await originale(input, init);
            } catch (err) {
                // La fetch non è mai arrivata al server: rete giù, DNS, CORS — oppure, molto
                // più spesso su una WebView, la richiesta troncata da un cambio pagina o dal
                // telefono che si addormenta. `warn`, non `error`, e niente affatto se
                // l'abbiamo annullata noi: vedi la testata di `eAnnullata`.
                senzaLanciare(() => {
                    if (eAnnullata(err)) return;
                    logClient({
                        livello: 'warn',
                        evento: 'fetch',
                        messaggio: `${metodo(req, init)} ${percorso(url)} — ${testoErrore(err)}`,
                        route: pagina(),
                        stato: 0,
                    });
                });
                throw err; // tale e quale: il chiamante deve vedere il SUO errore.
            }

            senzaLanciare(() => {
                if (res.ok) return;
                // NON tutti i `!res.ok` sono guasti, e quelli che non lo sono NON si spediscono
                // affatto: una sessione scaduta (401) o una password sbagliata (400 su
                // `/auth/v1/token`) diventerebbero righe `error` in `app_log` per ogni utente e
                // ogni giorno. Vedi `livelloFetch` — è la politica di `with-route.ts`, vista
                // dall'altro lato dello stesso 401.
                const livello = livelloFetch(res.status);
                if (livello === null) return;
                logClient({
                    livello,
                    evento: 'fetch',
                    messaggio: `${metodo(req, init)} ${percorso(url)} → ${res.status}`,
                    route: pagina(),
                    stato: res.status,
                });
            });
            // Nessun `.clone()`: farebbe un tee dello stream e terrebbe in RAM una copia di
            // ogni risposta — e il corpo di un 4xx può contenere dati personali.
            return res;
        };

        window.addEventListener('error', (e) => {
            logClient({
                livello: 'error',
                evento: 'js',
                messaggio: e.message || 'errore js',
                stack: e.error instanceof Error ? e.error.stack : undefined,
                route: pagina(),
            });
            flush();
        });

        // NESSUNA boundary React copre questo caso, ed è la rete più importante che ci sia:
        // il repo ha ~249 `.catch(() => {})`, e ogni promise che nessuno gestisce finisce qui
        // e da nessun'altra parte.
        window.addEventListener('unhandledrejection', (e) => {
            const r: unknown = e.reason;
            logClient({
                livello: 'error',
                evento: 'unhandledrejection',
                messaggio: r instanceof Error ? r.message : testoErrore(r),
                stack: r instanceof Error ? r.stack : undefined,
                route: pagina(),
            });
            flush();
        });

        // `pagehide` e non `unload`: `unload` non spara mai su iOS, e su tutti i browser
        // moderni impedisce alla pagina di entrare nella bfcache. `visibilitychange → hidden`
        // è l'unico evento che l'app nativa riceve DAVVERO quando l'utente cambia app: su
        // mobile è il vero "sto chiudendo", e senza di lui la coda morirebbe in memoria.
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
        // Il dispositivo è tornato in rete: è il momento in cui la coda accumulata offline —
        // cioè i log che raccontano l'offline — può finalmente partire.
        window.addEventListener('online', flush);
    } catch {
        // Fail-open: un logger che non si installa è un logger perso, non un'app rotta.
    }
}

/**
 * L'osservabilità non può rompere ciò che osserva. `logClient` è già fail-open per
 * costruzione; questo è il secondo giro di rete, sul percorso più caldo dell'app (OGNI fetch).
 */
function senzaLanciare(fn: () => void): void {
    try {
        fn();
    } catch {
        // Si perde il log, non la risposta.
    }
}

/**
 * Cosa NON si logga. In ordine di importanza:
 *  · il sink stesso — è la prima difesa contro il ciclo, e vale anche per il fallback `fetch`;
 *  · gli URL che non sono http(s) né relativi (`data:`, `blob:`): rumore, e un `data:` può
 *    essere un file dell'utente incorporato nell'URL;
 *  · le chiamate INTERNE di Next (prefetch RSC, Server Action, HMR). Sono decine per pagina:
 *    senza escluderle, il log del client è un elenco di prefetch e l'errore vero è una riga
 *    su cento — cioè il log è inutilizzabile, che è il modo silenzioso di non avere log.
 */
function daIgnorare(url: string, req: Request | null, init: RequestInit | undefined): boolean {
    try {
        if (url.startsWith(SINK)) return true;
        if (!/^(https?:|\/)/.test(url)) return true;

        // `init.headers` PRIMA di `req.headers`: quando entrambi esistono, `init` vince (è la
        // semantica di `fetch`). Next passa i propri header come oggetto piano, non come
        // `Headers`: `new Headers(...)` normalizza le tre forme (oggetto, array, Headers).
        const h = new Headers(init?.headers ?? req?.headers ?? undefined);
        if (HEADER_NEXT.some((k) => h.has(k))) return true;

        // `_rsc` può comparire SENZA `=` (`?_rsc`): un `url.includes('_rsc=')` lo mancherebbe,
        // ed è la forma che Next usa davvero sui prefetch.
        return new URL(url, location.href).searchParams.has('_rsc');
    } catch {
        // Nel dubbio si LOGGA (non si ignora): un log di troppo è rumore, un log in meno è
        // un guasto che non si vede.
        return false;
    }
}

function metodo(req: Request | null, init: RequestInit | undefined): string {
    try {
        return String(init?.method ?? req?.method ?? 'GET').toUpperCase().slice(0, 10);
    } catch {
        return 'GET';
    }
}

/**
 * Della fetch si tiene solo il pathname, RIDOTTO A PATTERN. Le due cose non sono la stessa, e
 * confonderle è stato un bug vero: buttare la query string (`?userId=`, `?token=`, `?email=`)
 * non basta, perché in questa app la credenziale sta NEL PATH — `/m/<token>`,
 * `/api/public/forms/<token>/submit` è il modulo di preiscrizione di un minore, e chi ha
 * quell'URL ci entra. Il pathname nudo finiva dentro `messaggio`, e `messaggio` è una colonna
 * di `app_log`: 30 giorni, interrogabile in SQL.
 *
 * ⚠️ Il commento che stava qui prometteva che «la riduzione a pattern la rifà comunque il
 * server»: NON È VERO, ed era la parte peggiore. `redigiPath` il server lo applica alla sola
 * colonna `route`, mai al messaggio; `sanificaMessaggio` maschera email, codici fiscali e
 * vincoli Postgres — non i path. La difesa che chi leggeva credeva ci fosse non esisteva.
 * Adesso la riduzione si fa qui (e `/api/logs` la rifà davvero, sul messaggio, per i client
 * vecchi che continueranno a spedire path grezzi per mesi).
 */
function percorso(url: string): string {
    try {
        return redigiPath(new URL(url, location.href).pathname);
    } catch {
        // Niente `location` (prerender, worker) o URL indecifrabile: si riduce ciò che c'è.
        // `redigiPathSicuro` toglie query e frammento da sé, e non lancia per nessun input.
        return redigiPathSicuro(url);
    }
}

/**
 * La pagina su cui l'utente si trovava: il LUOGO dell'incidente. Mai la query string, mai un
 * segmento opaco — un errore capitato SULLA pagina `/m/<token>` porterebbe il token con sé.
 */
function pagina(): string {
    try {
        return redigiPath(location.pathname);
    } catch {
        return '';
    }
}

/**
 * Il testo di un errore, senza mai invocare `toString` di un oggetto ostile. `String(err)` su
 * un oggetto senza prototipo lancia — dentro un gestore d'errore, cioè nel posto peggiore.
 */
function testoErrore(err: unknown): string {
    try {
        if (err instanceof Error) return err.message || err.name;
        return tronca(String(err), 200);
    } catch {
        return '[errore-illeggibile]';
    }
}
