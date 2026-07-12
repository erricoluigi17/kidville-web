import { AsyncLocalStorage } from 'node:async_hooks';
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
 * Questo modulo importa `node:async_hooks`: NON deve essere importato dal
 * middleware (che gira su Edge) né da codice client. Se accade, `npm run build`
 * fallisce rumorosamente — ed è il comportamento voluto.
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
     * `[redatto:str/40]` su `[redatto:str/…]` e cancellerebbe i marcatori (`[payload-troppo-grande]`
     * diventerebbe una stringa redatta come un'altra).
     */
    payload?: Record<string, unknown>;
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

export function contesto(): ContestoRichiesta | undefined {
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
 * Gli errori di `fn` NON vengono ingoiati: il contesto osserva, non interferisce.
 */
export function conContesto<T>(
    iniziale: ContestoRichiesta,
    fn: () => Promise<T>,
): Promise<T> {
    // Copia: lo store è mutabile (`impostaUtente`) e non deve essere l'oggetto del chiamante.
    const store: ContestoRichiesta = { ...iniziale, path: pathSicuro(iniziale.path) };
    return als.run(store, fn);
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

/** Non più di 4 slot: una route può chiamare parseData/parseQuery/parseBody più volte. */
const PAYLOAD_SLOT_MAX = 4;
/** Tetto in caratteri del singolo slot, misurato DOPO la redazione. */
const PAYLOAD_PESO_MAX = 2_000;
/** Marcatore degli slot scartati: un log che tace su ciò che ha perso è un log che mente. */
const SLOT_SCARTATI = '[…]';

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
 * non resta il body intero appeso al contesto fino a fine richiesta. Sopra `PAYLOAD_PESO_MAX`
 * anche il residuo redatto viene buttato: per un log di diagnosi 2 KB di payload bastano.
 */
export function impostaPayload(dove: string, valore: unknown): void {
    const s = als.getStore();
    if (!s) return;
    try {
        const payload: Record<string, unknown> = { ...(s.payload ?? {}) };

        const slotUsati = Object.keys(payload).filter((k) => k !== SLOT_SCARTATI).length;
        if (!(dove in payload) && slotUsati >= PAYLOAD_SLOT_MAX) {
            payload[SLOT_SCARTATI] = '[slot in eccesso: scartati]';
            s.payload = payload;
            return;
        }

        const redatto = redact(valore);
        // `serializza` non lancia e tronca da sé: qui serve solo a PESARE il residuo.
        const troppoGrande = serializza(redatto, PAYLOAD_PESO_MAX + 1).length > PAYLOAD_PESO_MAX;
        payload[dove] = troppoGrande ? '[payload-troppo-grande]' : redatto;
        s.payload = payload;
    } catch {
        // Il contesto è osservabilità: non può far fallire la richiesta che sta osservando.
    }
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
 * Ritorna `undefined` quando l'emissione è stata scartata — il chiamante non deve distinguere:
 * un log perso è il male minore, un log ricorsivo abbatte la funzione.
 *
 * Funziona anche FUORI da una richiesta (cron, boot): vedi `alsLogger`.
 */
export function entraNelLogger<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (inLogger()) return Promise.resolve(undefined);
    try {
        return alsLogger.run(true, fn);
    } catch (e) {
        // Ritorna SEMPRE una promise, non lancia mai in modo sincrono. `() => { throw … }` ha
        // tipo `() => never` ed è assegnabile a `() => Promise<T>`: un `fn` non-async che lancia
        // passa il typecheck. E il logger si usa fire-and-forget (`entraNelLogger(…).catch(…)`),
        // dove un throw sincrono scavalca il `.catch` e finisce nella route — cioè esattamente
        // la 200-che-diventa-500 che questo modulo esiste per non causare.
        return Promise.reject(e);
    }
}
