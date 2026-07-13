import { conContesto, contesto } from './context';
import { logErrore, logEvento, logOk } from './logger';

/**
 * `withRoute`: avvolge l'export di una route e ne osserva l'esito. Nient'altro.
 *
 * È il wrapper che andrà sulle 239 route del progetto, quindi vale prima di tutto la
 * regola d'oro del modulo: NIENTE qui dentro può lanciare. Un throw del wrapper
 * trasformerebbe una 200 in 500 su TUTTE le route insieme — un guasto totale causato
 * dall'osservabilità. L'unico throw che esce di qui è quello dell'HANDLER, rilanciato
 * tale e quale.
 *
 * COSA NON FA, E PERCHÉ (il contratto è fatto soprattutto di divieti):
 *
 * - NON assorbe i gate (`requireStaff`/`requireDocente`/`CRON_SECRET`) né `zod`. Non è
 *   pigrizia: `__tests__/api/zod-coverage.test.ts` e `scripts/audit-route-gates.mjs`
 *   riconoscono quei presidi per NOME TESTUALE nel sorgente della route. Un wrapper che
 *   li "assorbisse" farebbe sparire le stringhe dalle 239 route e spegnerebbe i due lock
 *   che garantiscono che i presidi ci siano. Il wrapper avvolge, non assorbe.
 *
 * - NON legge né clona il body. Le route fanno `await request.json()` dentro `parseBody`,
 *   e lo stream si consuma UNA volta sola: leggerlo qui le romperebbe tutte. Clonarlo
 *   sarebbe peggio ancora — sulle route multipart significherebbe tenere in RAM una copia
 *   di uno ZIP o di una foto da 20 MB per il gusto di loggarla. Il payload arriva dal
 *   contesto, dove lo deposita `parseBody` (già validato e già redatto).
 *
 * - NON usa API solo-`NextRequest` (`nextUrl`, `cookies`, `ip`): i ~90 test API del repo
 *   invocano gli handler con una `Request` NUDA (alcuni con `req() as never`), e in
 *   `p0-gates.test.ts` l'handler è chiamato come una funzione qualunque. Qui si leggono
 *   solo `url` e `headers`, che una Request nuda ha — e li si legge in modo difensivo,
 *   perché "as never" vuol dire che l'oggetto può essere qualunque cosa.
 *
 * - NON inghiotte le eccezioni: le logga e le RILANCIA. Inghiottirle cambierebbe la
 *   semantica in produzione (Next non vedrebbe più l'errore) e romperebbe i test che
 *   asseriscono i 500 espliciti delle route.
 *
 * POLITICA DEI LIVELLI (un 4xx non è un guasto del server):
 *
 *   2xx/3xx        → `logOk`                    KV_OK, console.log, MAI in tabella.
 *   4xx            → `logEvento(…, 'info', …)`  KV_EVT, console.log, MAI in tabella.
 *   5xx esplicito  → `logEvento(…, 'error', …)` KV_ERR + riga in tabella, MA nessun Error.
 *   eccezione      → `logErrore`                KV_ERR + Error VERO (stack vero) + tabella.
 *
 * Perché i 4xx a `info` e non a `warn`: `vaPersistito()` persiste error E warn, e i 401/403
 * dei gate sono frequentissimi (una sessione scaduta ne produce a raffica). A `warn`
 * finirebbero tutti in `app_log`, che diventerebbe una tabella di rumore in cui gli errori
 * veri non si trovano più. Restano comunque visibili su Vercel, che è dove si guarda un
 * "perché questa chiamata mi dà 403" — e dove lo status HTTP è già un metadato di piattaforma.
 *
 * Perché per un 5xx NON si fabbrica un errore: `logErrore` emette un Error NATIVO su console,
 * e `get_runtime_errors` di Vercel raggruppa per NOME dell'errore. Un `new Error('http_500')`
 * inventato dal wrapper si presenterebbe come un `Error` senza stack utile (punterebbe qui
 * dentro), mescolato agli errori veri: raggruppamento inquinato, stack che indica il logger
 * come colpevole. Un 5xx esplicito, poi, è quasi sempre il `catch` della route che ha già
 * l'errore VERO in mano: sarà quel `catch` a chiamare `logErrore` con lo stack buono
 * (Fase 2). Il wrapper registra l'ESITO, non inventa una causa.
 *
 * Conseguenza pratica: per il 5xx lo status finisce in `contesto_extra.campi.stato`
 * (JSONB, interrogabile) e non nella colonna `stato_http`, che `logEvento` non sa
 * riempire. La colonna la riempie `logErrore` — cioè la riga che porta la causa vera.
 *
 * Perché il nome della rotta viaggia come `operazione` e non come `rt` nelle righe di
 * fallimento: `redact()` è a lista bianca PER CHIAVE e `operazione` è in lista, `rt` no.
 * Su una riga persistita `rt: 'admin/parents/[id]:POST'` diventerebbe `[redatto:str/24]`
 * e la riga in tabella non direbbe più QUALE route ha fallito — il dato più importante
 * che ha. Su `logOk` (che non persiste nulla) resta `rt`, che è il campo previsto dalla
 * sua firma.
 */

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

/**
 * `A` è inferito dall'handler, quindi la firma della funzione avvolta è IDENTICA a quella
 * dell'handler: `(Request)` per le route statiche, `(Request, { params: Promise<…> })` per
 * le dinamiche. Serve perché `tsconfig.json` include `.next/types/**`: Next 16 genera un
 * validator che vincola il tipo degli export delle route, e un wrapper che appiattisse la
 * firma (es. `(...args: unknown[])`) farebbe fallire `npm run build` su tutte le dinamiche.
 */
export function withRoute<A extends [Request, ...unknown[]]>(
    nome: string,
    handler: Handler<A>,
): (...args: A) => Promise<Response> {
    return async (...args: A): Promise<Response> => {
        const t0 = Date.now();
        // Il requestId NON viene generato qui: si passa il valore grezzo dell'header (o la
        // stringa vuota) e lo normalizza `conContesto` — che sostituisce ciò che non è un id
        // plausibile. Due vantaggi: la logica anti-forgiatura sta in un posto solo, e non
        // serve `crypto.randomUUID()`, che non è garantito ovunque (sotto jsdom il repo lo
        // polyfilla a mano su `window`) e che qui sarebbe un throw del wrapper.
        return conContesto(
            { requestId: requestIdGrezzo(args[0]), path: pathDi(args[0]) },
            async () => {
                // L'id NORMALIZZATO, cioè quello che finirà davvero nei log. È questo che si
                // riflette sulla risposta: rimandare indietro l'header grezzo del client
                // significherebbe promettergli una correlazione che non esiste (nei log c'è
                // un altro id) — e riflettergli un valore arbitrario che lui controlla.
                const rid = contesto()?.requestId;

                let res: Response;
                try {
                    res = await handler(...args);
                } catch (err) {
                    // Loggato con l'errore VERO (stack vero) e RILANCIATO: il wrapper osserva,
                    // non decide. `senzaLanciare` perché un logger che esplode non deve poter
                    // sostituire l'errore della route con il proprio.
                    senzaLanciare(() => logErrore({ operazione: nome, ms: Date.now() - t0, stato: 500 }, err));
                    throw err;
                }

                senzaLanciare(() => registraEsito(nome, res, Date.now() - t0));
                senzaLanciare(() => rifletti(res, rid));
                return res;
            },
        );
    };
}

/** L'osservabilità non può rompere la risposta che sta osservando. */
function senzaLanciare(fn: () => void): void {
    try {
        fn();
    } catch {
        // I tre logger sono già fail-open per costruzione; questo try è la rete che regge
        // se un domani smettessero di esserlo. Su 239 route non è paranoia, è il costo di
        // una riga.
    }
}

function registraEsito(nome: string, res: unknown, ms: number): void {
    const stato = statoDi(res);
    // Status illeggibile (handler che non restituisce una Response): non è un errore
    // dimostrabile, e il wrapper non inventa guasti. Resta la riga di esito.
    if (stato === undefined || stato < 400) {
        logOk({ ms, rt: nome });
        return;
    }
    if (stato < 500) {
        logEvento('route', 'info', { operazione: nome, stato, ms });
        return;
    }
    logEvento('route', 'error', { operazione: nome, stato, ms });
}

/**
 * Rimette l'id di correlazione sulla risposta. `headers.set` LANCIA su una Response con
 * headers immutabili (`Response.redirect`, e le risposte che arrivano da un fetch): in quel
 * caso si perde l'header, non la risposta.
 */
function rifletti(res: unknown, rid: string | undefined): void {
    if (!rid) return;
    const headers = (res as { headers?: { set?: (n: string, v: string) => void } } | null | undefined)?.headers;
    headers?.set?.('x-request-id', rid);
}

/**
 * L'header grezzo, o `''`. Tutto è opzionale perché `args[0]` è una `Request` solo per
 * contratto: i test la passano `as never`, e in JS può arrivare qualunque cosa.
 * `x-vercel-id` come ripiego: è l'id che la piattaforma mette da sé sulla richiesta, quindi
 * correla la nostra riga con la voce di log di Vercel.
 */
function requestIdGrezzo(req: unknown): string {
    return intestazione(req, 'x-request-id') ?? intestazione(req, 'x-vercel-id') ?? '';
}

function intestazione(req: unknown, nome: string): string | undefined {
    try {
        const v = (req as { headers?: { get?: (n: string) => unknown } } | null | undefined)
            ?.headers?.get?.(nome);
        return typeof v === 'string' && v !== '' ? v : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Base fittizia: rende parsabile anche un url RELATIVO (`/api/x`), che nei test è una forma
 * plausibile. Non finisce da nessuna parte — si tiene solo il `pathname`, e comunque a
 * ridurlo a pattern (via query string, via token e uuid) ci pensa `conContesto`.
 */
const BASE_FITTIZIA = 'http://l';

function pathDi(req: unknown): string {
    let url: unknown;
    try {
        url = (req as { url?: unknown } | null | undefined)?.url;
    } catch {
        return '[url-illeggibile]';
    }
    if (typeof url !== 'string' || url === '') return '';
    try {
        return new URL(url, BASE_FITTIZIA).pathname;
    } catch {
        // Un log che tace su ciò che ha perso è un log che mente: si dice che il path c'era
        // e non si è potuto leggere, invece di lasciare il campo vuoto come se non ci fosse.
        return '[url-illeggibile]';
    }
}

function statoDi(res: unknown): number | undefined {
    try {
        const s = (res as { status?: unknown } | null | undefined)?.status;
        return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
    } catch {
        return undefined;
    }
}
