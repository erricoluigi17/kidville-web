import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { redact, redigiPath } from './redact';
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
     */
    path: string;
    userId?: string;
    ruolo?: string;
    scuolaId?: string;
    /**
     * Payload già validato e GIÀ REDATTO da `impostaPayload`; stampato solo se la richiesta
     * fallisce. Chi lo emette NON deve ri-redigerlo: una seconda passata di `redact` rifarebbe
     * `[redatto:str/40]` su `[redatto:str/…]` e cancellerebbe i marcatori
     * (`[payload-troppo-grande]` diventerebbe una stringa redatta come un'altra).
     */
    payload?: Readonly<Record<string, unknown>>;
}

const als = new AsyncLocalStorage<ContestoRichiesta>();

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
    if (!s) return;
    if (u.userId) s.userId = u.userId;
    if (u.ruolo) s.ruolo = u.ruolo;
    if (u.scuolaId) s.scuolaId = u.scuolaId;
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
 * la scelta a 239 route. `redact()` è a lista bianca e non lancia mai.
 *
 * Redigere al deposito è anche ciò che tiene a bada la RAM: `redact` tronca gli array a 20
 * elementi, gli oggetti a 40 chiavi e la profondità a 5, quindi di un import da 5.000 record
 * non resta il body intero appeso al contesto fino a fine richiesta. Sopra
 * `PAYLOAD_CARATTERI_MAX` anche il residuo redatto viene buttato: per sapere *cosa* si stava
 * tentando, 2.000 caratteri bastano.
 */
export function impostaPayload(dove: string, valore: unknown): void {
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

        const redatto = redact(valore);
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
