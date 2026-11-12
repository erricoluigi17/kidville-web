import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { redact, redactInput, redigiPath } from './redact';
import { serializza } from './serialize';

/**
 * Contesto della richiesta corrente, propagato implicitamente lungo la catena
 * async. Serve a correlare fra loro le righe della stessa richiesta (su Fluid
 * Compute più invocazioni condividono lo stesso processo Node, quindi il flusso
 * di log è intrecciato: senza un id di correlazione è illeggibile).
 *
 * REGOLE INDEROGABILI (Fluid Compute):
 *  - si entra SOLO con `als.run(...)`, MAI con `enterWith()` (contamina il
 *    contesto corrente e può colare su richieste successive);
 *  - MAI tenere userId/ruolo/flag in variabili di modulo: due richieste concorrenti
 *    si sovrascriverebbero a vicenda. L'istanza di AsyncLocalStorage a livello
 *    di modulo va invece benissimo: è lo *store* a essere per-catena.
 *
 * Regola d'oro dell'intero modulo: NIENTE qui dentro può lanciare. Un throw nel
 * logger trasforma una 200 in 500 su tutte le route.
 *
 * RUNTIME: è codice server-only. NON è però vero che importarlo dal middleware farebbe
 * fallire la build per via di `node:async_hooks`: l'Edge Runtime di Next quel modulo lo
 * ESPONE. A saltare sarebbe semmai `node:crypto` (qui sotto, e transitivamente da
 * `redact.ts`), che l'Edge rifiuta. Una rete c'è, quindi, ma è quella e passa da un altro
 * import: non è una garanzia che questo modulo possa promettere di suo.
 */

export interface ContestoRichiesta {
    requestId: string;
    /**
     * SEMPRE un pattern di route, mai il path grezzo: ci pensa `conContesto`.
     * Vedi lì il perché (in questo repo il path È una credenziale).
     *
     * ⚠️ NON È UN CAMPO MORTO, anche se oggi nessun emettitore lo stampa: le righe di Vercel
     * non lo portano di proposito (la piattaforma conosce già metodo e path come metadati
     * suoi), ma il Task 8 popola da qui la colonna `app_log.route` — che è ciò che rende
     * interrogabile in SQL "quante volte ha fallito QUESTA route". Non rimuoverlo.
     */
    path: string;
    /**
     * Il NOME della route, quello passato a `withRoute` (es. `admin/sections:POST`): un letterale
     * del codice, mai un dato. Lo legge `supabase-fetch` per l'header `x-kidville-route`.
     * Diverso da `path`, che `redigiPath` riduce a `[tok]`.
     */
    route?: string;
    userId?: string;
    ruolo?: string;
    scuolaId?: string;
    /**
     * "Per questa richiesta un errore è GIÀ stato loggato, con lo stack vero, da chi lo aveva
     * in mano." La alza `logErrore`; la legge `withRoute`, che senza di essa emetterebbe una
     * SECONDA riga per lo stesso guasto — la meno informativa delle due (un 5xx esplicito è
     * quasi sempre un `catch` che ha già loggato la causa). Su 239 route sarebbe il doppio
     * delle righe, e il budget dichiarato è "1-2 righe per richiesta, non dieci".
     */
    erroreLoggato?: boolean;
    /**
     * "Il database ha rifiutato una scrittura di questa richiesta con un codice dell'anno
     * scolastico" (`ANNO_CHIUSO`…): il PRIMO, mai sovrascritto. Lo alza il `fetch` strumentato
     * dei client Supabase, che è l'unico a leggere il corpo dell'errore; lo legge `withRoute`, che
     * trasforma il 500 generico della route in 409/422 (Compito 3.4, D4). `message` è sempre un
     * elemento di `CODICI_ANNO` (un letterale nostro, mai testo del database); `code` quello di
     * PostgREST (`P0001`, `23514`…).
     */
    erroreAnno?: { code: string; message: string; gestito?: true };
    /**
     * Payload già validato e GIÀ REDATTO da `impostaPayload`; stampato solo se la richiesta
     * fallisce. Chi lo emette NON deve ri-redigerlo: una seconda passata di `redact` rifarebbe
     * `[redatto:str/40]` su `[redatto:str/…]` e cancellerebbe i marcatori
     * (`[payload-troppo-grande]` diventerebbe una stringa redatta come un'altra).
     */
    payload?: Readonly<Record<string, unknown>>;
}

const als = new AsyncLocalStorage<ContestoRichiesta>();
const richiesteCrmAi = new WeakMap<ContestoRichiesta, Request | null>();
const delegheCrmAi = new WeakMap<ContestoRichiesta, WeakMap<Request, ContestoRichiesta>>();

/**
 * Guardia di rientranza, su un ALS SEPARATO. Due ragioni, entrambe vincolanti:
 *
 * 1. Un flag sullo store della richiesta (`s.dentroIlLogger = true`) protegge solo
 *    DENTRO una richiesta: in un cron, al boot o in un `waitUntil` non c'è store, e
 *    la guardia non guarderebbe nulla — proprio dove una ricorsione del logger
 *    girerebbe senza nessuno a guardare. Un flag di MODULO, invece, è condiviso fra
 *    richieste concorrenti: è esattamente ciò che le regole qui sopra vietano.
 *
 * 2. Un flag sullo store è per-RICHIESTA, non per-catena: `Promise.all([logga(a),
 *    logga(b)])` vedrebbe la seconda emissione trovare il flag della prima e sparire
 *    in silenzio. Ma la rientranza è una relazione ANTENATO→DISCENDENTE ("questo log
 *    nasce DENTRO l'emissione di un altro log"), non "due log nello stesso istante".
 *
 * Un AsyncLocalStorage dedicato dice esattamente quello: lo store è visibile solo alla
 * discendenza async di `entraNelLogger`, non alle sorelle, e non ha bisogno di una
 * richiesta per esistere.
 */
const alsLogger = new AsyncLocalStorage<true>();

/** Solo questa catena (dry-run) osserva senza scrivere audit nel database. */
const alsSoloConsole = new AsyncLocalStorage<true>();
export function conLogSoloConsole<T>(fn: () => Promise<T>): Promise<T> {
    // run propaga risultato ed errori applicativi e non contamina le richieste sorelle.
    return alsSoloConsole.run(true, fn);
}
export function logSoloConsole(): boolean {
    return alsSoloConsole.getStore() === true;
}

/**
 * Il contesto è di SOLA LETTURA. Le scritture passano da `impostaUtente`/`impostaPayload`,
 * che sono i due punti dove valgono redazione, cap e conteggio degli slot. Consegnare lo
 * store nudo significherebbe che un qualunque call-site può scrivere
 * `contesto()!.payload = { body: await req.json() }` — PII grezza in un campo che l'emittente
 * ha l'ordine di NON ri-redigere — o riscrivere `userId`, attribuendo le righe alla persona
 * sbagliata. È lo stesso argomento per cui `redigiPath` e `redact` stanno dentro questo modulo
 * e non nelle 239 route: non lasciare la scelta al chiamante.
 * `Readonly` è solo un tipo: costo a runtime zero, e lo store interno resta mutabile.
 */
export function contesto(): Readonly<ContestoRichiesta> | undefined {
    return als.getStore();
}

/**
 * Apre il contesto per una richiesta. `fn` è eseguita dentro `als.run`, quindi tutta la
 * sua discendenza async vede lo stesso store — e nessun'altra richiesta lo vede.
 *
 * Il `path` viene NORMALIZZATO qui, non dal chiamante. Non è pignoleria: in questo repo il
 * token del modulo pubblico è un SEGMENTO di path (`/m/<token>`, `/api/public/forms/<token>/submit`)
 * ed è una capability; le query string trasportano `?userId=`, `?email=`. Un path grezzo nei
 * log è una credenziale nei log — e il path finisce in OGNI riga della richiesta. Farlo qui
 * significa che nessun chiamante può sbagliare, invece di sperare che ogni chiamante ricordi.
 * (Ed è anche l'unica forma utile per correlare: si aggrega per route, non per id.)
 *
 * Il valore di ritorno di `fn` è restituito tale e quale, e gli errori di `fn` NON vengono
 * ingoiati: il contesto osserva, non interferisce.
 */
export function conContesto<T>(
    iniziale: ContestoRichiesta,
    fn: () => Promise<T>,
): Promise<T> {
    // Copia: lo store è mutabile (`impostaUtente`) e non deve essere l'oggetto del chiamante.
    const store: ContestoRichiesta = {
        ...iniziale,
        requestId: requestIdSicuro(iniziale.requestId),
        path: pathSicuro(iniziale.path),
    };
    return als.run(store, fn);
}

const PATH_CHIAVI_CRM = '/api/admin/crm/integrazioni';
const FORMA_PATH_CHIAVI_CRM = /^\/api\/admin\/crm\/integrazioni(?:\/([^/]+))?\/?$/;

/** Riconosce le due route delle chiavi e restituisce il pattern, senza riportare l’id richiesto. */
export function pathTecnicoChiaviCrm(nome = '', path = ''): string | null {
    if (nome === 'admin/crm/integrazioni:GET' || nome === 'admin/crm/integrazioni:POST') return PATH_CHIAVI_CRM;
    if (nome === 'admin/crm/integrazioni/[id]:DELETE') return PATH_CHIAVI_CRM + '/[id]';
    const match = FORMA_PATH_CHIAVI_CRM.exec(path);
    if (!match) return null;
    return match[1] ? PATH_CHIAVI_CRM + '/[id]' : PATH_CHIAVI_CRM;
}

/**
 * Le route CRM AI e di gestione delle chiavi hanno un contesto di soli metadati. Si riusa solo lo store
 * già protetto della stessa Request; da un contesto esterno non si eredita nulla.
 * `path` e `route` vengono scelti dal codice. Il limitatore può aprire uno store
 * tecnico senza una Request, quando il gruppo CRM AI è l'unico indicatore.
 */
export function conContestoCrmAi<T>(
    richiesta: Request | null,
    route: string,
    path: string,
    fn: () => Promise<T>,
): Promise<T> {
    const corrente = als.getStore();
    if (corrente && richiesta && richiesteCrmAi.get(corrente) === richiesta) return fn();
    const deleghe = corrente && richiesta ? delegheCrmAi.get(corrente) : undefined;
    const precedente = richiesta && deleghe?.get(richiesta);
    if (precedente) return als.run(precedente, fn);

    const store = { requestId: requestIdSicuro(''), path: pathSicuro(path), route };
    richiesteCrmAi.set(store, richiesta);
    if (corrente && typeof richiesta === 'object' && richiesta !== null) {
        const mappa = deleghe ?? new WeakMap<Request, ContestoRichiesta>();
        mappa.set(richiesta, store);
        delegheCrmAi.set(corrente, mappa);
    }
    return als.run(store, fn);
}

/** Verifica che lo store sia stato aperto come contesto di soli metadati. */
export function contestoCrmAiAttivo(): boolean {
    const s = als.getStore();
    return s !== undefined && richiesteCrmAi.has(s);
}

/**
 * Completa una Request delegata a un wrapper CRM AI. Il legame vale soltanto
 * per la stessa Request nello stesso store esterno, anche se cambia la Response.
 */
export function conContestoCompletamentoCrmAi<T>(
    richiesta: Request,
    completa: (delegata: boolean) => T,
): T {
    const corrente = als.getStore();
    const delegato = corrente && delegheCrmAi.get(corrente)?.get(richiesta);
    return delegato ? als.run(delegato, () => completa(true)) : completa(false);
}

/**
 * Il requestId arriva tipicamente da un header (`x-request-id`, `x-vercel-id`): è INPUT DEL
 * CLIENT. Finisce in ogni riga di un formato A RIGHE, quindi un `\n` nel valore non è un
 * carattere strano: è una riga di log FALSA, scritta da chi fa la richiesta. Stesso argomento
 * del path — non ci si affida alla buona educazione del chiamante.
 *
 * Fail-closed: ciò che non è un id plausibile non viene ripulito, viene SOSTITUITO. Un id
 * "aggiustato" correlerebbe male e in silenzio; un id nuovo correla bene, e la richiesta
 * resta ritrovabile dagli altri campi.
 */
const REQUEST_ID_PLAUSIBILE = /^[A-Za-z0-9_:.-]{1,64}$/;

function requestIdSicuro(v: unknown): string {
    try {
        if (typeof v === 'string' && REQUEST_ID_PLAUSIBILE.test(v)) return v;
        return randomUUID();
    } catch {
        return '[request-id-illeggibile]';
    }
}

/** `redigiPath` su un path che potrebbe non essere una stringa (chiamante JS, path assente). */
function pathSicuro(v: unknown): string {
    try {
        return redigiPath(typeof v === 'string' ? v : String(v ?? ''));
    } catch {
        return '[path-illeggibile]';
    }
}

/**
 * Arricchisce il contesto della richiesta CORRENTE con l'identità, appena il gate auth la
 * conosce. Fuori da una richiesta è un no-op: non esiste posto dove metterla che non sia
 * condiviso con le altre richieste in volo.
 *
 * Accetta `null` perché è ciò che restituiscono le colonne opzionali (`scuola_id`): un
 * valore assente non deve sovrascrivere né sporcare il contesto.
 */
export function impostaUtente(u: {
    userId?: string | null;
    ruolo?: string | null;
    scuolaId?: string | null;
}): void {
    const s = als.getStore();
    if (!s || richiesteCrmAi.has(s)) return;
    if (u.userId) s.userId = u.userId;
    if (u.ruolo) s.ruolo = u.ruolo;
    if (u.scuolaId) s.scuolaId = u.scuolaId;
}

/**
 * Marca la richiesta corrente come "errore già loggato". La chiama `logErrore`, che è
 * l'unico punto del sistema che vede l'errore VERO (con il suo stack).
 *
 * Fuori da una richiesta è un no-op, come `impostaUtente`: senza store non c'è nessun posto
 * dove tenerla che non sia condiviso con le altre richieste in volo. Conseguenza voluta: in
 * un cron non c'è deduplica, e va bene — non c'è nemmeno un wrapper che duplichi.
 */
export function segnalaErroreLoggato(): void {
    const s = als.getStore();
    if (!s) return;
    s.erroreLoggato = true;
}

/** Vera se `logErrore` è già passato per questa richiesta. Fuori da una richiesta: falsa. */
export function erroreGiaLoggato(): boolean {
    return als.getStore()?.erroreLoggato === true;
}

/**
 * Segna che per questa richiesta il database ha rifiutato una scrittura con un codice dell'anno.
 * Si tiene il PRIMO: i successivi non lo sovrascrivono (la prima causa è quella che l'utente deve
 * vedere). Fuori da una richiesta è un no-op e non lancia, come `segnalaErroreLoggato`.
 */
export function segnalaErroreAnno(code: string, message: string): void {
    const s = als.getStore();
    if (!s) return;
    // Un errore già GESTITO da una scrittura fail-open (`segnalaErroreAnnoGestito`) non occupa il posto: il
    // primo errore NON gestito è quello che la rete di `withRoute` deve tradurre.
    if (s.erroreAnno === undefined || s.erroreAnno.gestito) s.erroreAnno = { code, message };
}

/**
 * Segna come GESTITO l'errore dell'anno già registrato per `message` (un codice di `CODICI_ANNO`): lo chiama
 * una scrittura fail-open (`scriviFrequenza`) che l'ha loggato ed è andata avanti. La rete di `withRoute` lo
 * ignora: se la route risponde poi 500 per un'altra ragione, quel 500 non diventa il 409/422 di questo errore.
 * Non tocca un errore diverso (il primo non gestito resta). Fuori da una richiesta: no-op.
 */
export function segnalaErroreAnnoGestito(message: string): void {
    const s = als.getStore();
    if (!s?.erroreAnno || s.erroreAnno.gestito) return;
    if (s.erroreAnno.message === message) s.erroreAnno.gestito = true;
}

/** L'errore dell'anno segnato per questa richiesta, se c'è. Fuori da una richiesta: `undefined`. */
export function erroreAnnoDellaRichiesta(): { code: string; message: string } | undefined {
    const e = als.getStore()?.erroreAnno;
    return e && !e.gestito ? e : undefined;
}

/**
 * Quattro slot: i tre canonici (`body`, `query`, `params`) più uno di margine, perché
 * `parseData` è chiamata anche sui campi estratti a mano da un multipart. Il quinto sarebbe
 * già un chiamante che si inventa un vocabolario: si scarta, marcando.
 */
const PAYLOAD_SLOT_MAX = 4;
/**
 * Tetto del singolo slot in CARATTERI (UTF-16), misurato DOPO la redazione. Non sono byte:
 * qui il vincolo è la RAM trattenuta fino a fine richiesta, non la riga di Vercel (che ha il
 * suo cap, in byte, dove il logger la emette con `serializza`).
 */
const PAYLOAD_CARATTERI_MAX = 2_000;
/** Marcatore degli slot scartati: un log che tace su ciò che ha perso è un log che mente. */
const SLOT_SCARTATI = '[…]';
const CONTEGGIO_SCARTATI = /^\[\+(\d+) /;

/**
 * Deposita il payload validato di una richiesta. `dove` = 'body' | 'query' | 'params'.
 * Viene stampato solo quando la richiesta fallisce: è la ricostruzione di *cosa* si stava
 * tentando.
 *
 * Il valore è REDATTO QUI, non dal chiamante — stesso principio del `path`: l'unico modo
 * per garantire che nel contesto non finisca mai un dato personale grezzo è non lasciare
 * la scelta a 239 route.
 *
 * ⚠️ `redactInput` e non `redact`: quello che arriva qui viene DALLA RETE, e la lista bianca
 * di `redact` presuppone che il nome del campo l'abbia scelto il nostro codice. Sotto
 * `payload` lo sceglie chi fa la richiesta — vedi la testata di `redactInput`. Un valore
 * nostro da depositare qui passa da `impostaPayloadEsito`.
 *
 * Redigere al deposito è anche ciò che tiene a bada la RAM: la redazione tronca gli array a 20
 * elementi, gli oggetti a 40 chiavi e la profondità a 5, quindi di un import da 5.000 record
 * non resta il body intero appeso al contesto fino a fine richiesta. Sopra
 * `PAYLOAD_CARATTERI_MAX` anche il residuo redatto viene buttato: per sapere *cosa* si stava
 * tentando, 2.000 caratteri bastano.
 */
export function impostaPayload(dove: string, valore: unknown): void {
    // Uscita rapida fuori da una richiesta: senza store non c'è niente da depositare, e
    // redigere per buttare via costerebbe una passata su ogni body in un cron o in un test.
    const s = als.getStore();
    if (!s || richiesteCrmAi.has(s)) return;
    deposita(dove, redactInput(valore));
}

/**
 * Deposita una DIAGNOSI NOSTRA nello slot di un payload — non un valore del client.
 *
 * Serve ai due casi in cui un payload da depositare non c'è (`body-json-malformato`,
 * `richiesta-non-multipart`): lì la stringa la scrive il nostro codice, ed è l'unica cosa che
 * distingue «questa richiesta non ha loggato il corpo» da «un corpo non ce l'aveva». Passa
 * quindi da `redact`, che la lascia in chiaro sotto `esito`, mentre `impostaPayload` — che
 * tratta input di rete — la ridurrebbe a `[redatto:str/21]`, cioè a un log che non dice nulla.
 *
 * L'`esito` è un enumerato scritto a mano nel sorgente: non è mai un valore di richiesta.
 */
export function impostaPayloadEsito(dove: string, esito: string): void {
    const s = als.getStore();
    if (!s || richiesteCrmAi.has(s)) return;
    deposita(dove, redact({ esito }));
}

function deposita(dove: string, redatto: unknown): void {
    const s = als.getStore();
    if (!s) return;
    try {
        // Prototipo nullo, come in `redact.ts`: `dove` oggi è interno, ma su un oggetto
        // letterale `'toString' in payload` sarebbe true (aggirando il conteggio degli slot)
        // e `impostaPayload('__proto__', …)` scriverebbe il prototipo. Difendersi costa una riga.
        const payload: Record<string, unknown> = Object.assign(Object.create(null), s.payload);

        if (!Object.hasOwn(payload, dove) && slotUsati(payload) >= PAYLOAD_SLOT_MAX) {
            payload[SLOT_SCARTATI] = `[+${scartatiFinora(payload) + 1} slot scartati]`;
            s.payload = payload;
            return;
        }

        // `serializza` non lancia e tronca da sé: qui serve solo a PESARE il residuo.
        const troppoGrande =
            serializza(redatto, PAYLOAD_CARATTERI_MAX + 1).length > PAYLOAD_CARATTERI_MAX;
        payload[dove] = troppoGrande ? '[payload-troppo-grande]' : redatto;
        s.payload = payload;
    } catch {
        // Il contesto è osservabilità: non può far fallire la richiesta che sta osservando.
    }
}

function slotUsati(payload: Record<string, unknown>): number {
    return Object.keys(payload).filter((k) => k !== SLOT_SCARTATI).length;
}

function scartatiFinora(payload: Record<string, unknown>): number {
    const marcatore = payload[SLOT_SCARTATI];
    if (typeof marcatore !== 'string') return 0;
    const m = CONTEGGIO_SCARTATI.exec(marcatore);
    return m === null ? 0 : Number(m[1]);
}

export function inLogger(): boolean {
    return alsLogger.getStore() === true;
}

/**
 * Esegue una scrittura del logger marcando la catena async. Se durante questa esecuzione il
 * logger prova a loggare di nuovo (es. l'insert su `app_log` fallisce e il gestore d'errore
 * logga l'errore), `inLogger()` è true e la seconda emissione viene scartata: senza questa
 * guardia si otterrebbe una ricorsione fino all'esaurimento della memoria.
 *
 * NON LANCIA E NON RIGETTA MAI, per nessun input:
 *  - un `fn` non-async che lancia ha tipo `() => never`, che passa il typecheck di
 *    `() => Promise<T>`: senza il try il throw uscirebbe SINCRONO, scavalcando il `.catch`
 *    di un chiamante fire-and-forget e finendo nella route;
 *  - e una promise RIFIUTATA non sarebbe più sicura: il chiamante naturale è
 *    `void entraNelLogger(…)`, e su Node ≥ 15 una unhandled rejection ABBATTE IL PROCESSO —
 *    peggio del 500 che questo modulo esiste per evitare.
 *
 * Entrambi i casi si risolvono quindi a `undefined`, che è già il valore dell'emissione
 * scartata: se il male minore è un log perso — ed è la premessa di tutto il modulo — vale
 * anche quando a fallire è il logger stesso. Chi vuole sapere che l'emissione non è andata
 * lo deduce da `undefined`; chi non guarda, non muore.
 */
export function entraNelLogger<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (inLogger()) return Promise.resolve(undefined);
    try {
        return Promise.resolve(alsLogger.run(true, fn)).catch(() => undefined);
    } catch {
        return Promise.resolve(undefined);
    }
}
