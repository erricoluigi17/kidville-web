import { contesto, inLogger, entraNelLogger } from './context';
import { descriviErrore, sanificaMessaggio, serializza, type ErroreDescritto } from './serialize';
import { redact } from './redact';
import { appLog, type RigaLog } from './app-log';

/**
 * Il logger: marker atomico + logfmt.
 *
 * PERCHÉ QUESTO FORMATO (non è arbitrario):
 *
 * - Vercel NON parsa né indicizza il JSON dentro il messaggio: sul contenuto c'è solo
 *   ricerca full-text. Il MARKER (`KV_OK`, `KV_ERR`, `KV_WARN`, `KV_EVT`) è un token
 *   alfanumerico proprio perché è l'unica àncora che sopravvive con certezza alla
 *   tokenizzazione: un marker con punteggiatura (`evt=req.err`) non è garantito.
 * - Una lettura di log restituisce al massimo 100 righe. Un logger loquace ACCECA:
 *   100 righe = 10 richieste viste. Perciò 1-2 righe per richiesta, non dieci.
 * - Non si loggano metodo/path/status: Vercel li conosce già come metadati di
 *   piattaforma. Si logga solo ciò che Vercel NON sa (utente, ruolo, sede, durata,
 *   codice d'errore del provider, esito).
 * - Solo `console.log` e `console.error`. `console.warn` NON produce il livello
 *   `warning` nelle funzioni non-streaming: produce `error`, e inquinerebbe il filtro.
 *
 * Regola d'oro dell'intero modulo: NIENTE qui dentro può lanciare. Un throw nel logger
 * trasforma una 200 in 500 su tutte le 239 route del progetto. Ogni emissione è avvolta
 * in un try/catch: si perde un log, non una risposta.
 */

export type Livello = 'info' | 'warn' | 'error';
export type Valore = string | number | boolean | null | undefined;

/**
 * Guardia valutata UNA VOLTA al caricamento del modulo, non a ogni richiesta:
 * `__tests__/api/p0-gates.test.ts` stubba NODE_ENV a 'production' a runtime, quindi
 * NODE_ENV non è affidabile come discriminante.
 *
 * Silenzia DUE canali, non uno: console e persistenza. La persistenza soprattutto —
 * `.env.local` punta al DB di PRODUZIONE, e una suite di test che scrive righe di log
 * in produzione è un incidente, non un test.
 */
const SILENZIOSO = !!process.env.VITEST || process.env.KV_LOG_LEVEL === 'silent';

/** Eventi i cui SUCCESSI vengono persistiti (deroga a "solo warn+error in tabella"). */
export const EVENTI_PERSISTITI = new Set(['email', 'push', 'cron', 'fattura', 'pagamento', 'config']);

/**
 * BUDGET DELLA RIGA. Vercel tronca le righe lunghe (~3.500 caratteri) e taglia dalla CODA.
 * Da qui la politica di priorità:
 *
 *  1. Sulla riga vanno solo campi CORTI e ad alto valore, in ordine di importanza
 *     decrescente: contesto (rid/uid/ruolo/sede) → op/evt/code/stato/ms/digest →
 *     msg → det → causa → payload. Se il taglio arriva, mangia il payload (il meno
 *     importante), mai il codice d'errore.
 *  2. Lo STACK non sta sulla riga. Sarebbe da solo fino a 2.000 caratteri, e con una
 *     `causa` che ne porta un altro si sfonderebbero i 3.500: il taglio cadrebbe sulla
 *     coda e si perderebbe proprio la causa, che è l'errore vero. Lo stack esce nella
 *     SECONDA emissione, l'Error nativo, dove Vercel dà 256 KB.
 *  3. Il MESSAGGIO della causa, invece, sta sulla riga (`causa=`): è corto, ed è ciò che
 *     dice cos'è andato storto davvero. Politica: sulla riga i messaggi, nell'Error gli stack.
 */
const LIMITE_RIGA = 3_500;
/** Tetto del singolo campo: un valore impazzito non deve poter sfrattare quelli dopo di lui. */
const CAMPO_MAX = 900;
/** Il payload è l'ultimo campo della riga: gli si dà spazio, ma non troppo. */
const PAYLOAD_MAX = 800;

function tronca(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Quota il valore se contiene spazi, `"` o `=` — cioè se senza virgolette la coppia
 * chiave=valore non si rileggerebbe. Gli A CAPO sono nella classe `\s` e vanno quotati
 * per una ragione più forte della leggibilità: un `\n` grezzo SPEZZEREBBE la riga in due
 * voci di log distinte, e la seconda non avrebbe il marker — invisibile alla ricerca.
 * `JSON.stringify` li rende `\n` letterali. Stessa cosa per i caratteri di controllo,
 * che `\s` non copre tutti.
 */
const DA_QUOTARE = /[\s"=\p{Cc}]/u;

/**
 * Il `String(v)` è dentro il try, e il try è PER CAMPO: `Valore` esclude gli oggetti, ma
 * il logger è chiamato anche da JS senza tipi, e un `toString` che lancia deve costare
 * QUEL campo — non l'intera riga. Stessa disciplina di `redact.ts`.
 */
function quota(v: Valore): string {
    try {
        const s = tronca(String(v), CAMPO_MAX);
        return DA_QUOTARE.test(s) ? JSON.stringify(s) : s;
    } catch {
        return '[campo-illeggibile]';
    }
}

/**
 * `null`, `undefined` e `''` si OMETTONO: `uid=undefined` occupa spazio e non dice nulla.
 * `0` e `false`, invece, restano: sono informazione ("zero elementi", "non riuscito").
 */
export function formattaRiga(marker: string, campi: Record<string, Valore>): string {
    try {
        const coppie = Object.entries(campi)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}=${quota(v)}`);
        const riga = coppie.length ? `${marker} ${coppie.join(' ')}` : marker;
        // Il taglio può cadere dentro un valore quotato lasciando una virgoletta spaiata:
        // è accettabile: la riga non viene mai riparsata, viene cercata full-text.
        return tronca(riga, LIMITE_RIGA);
    } catch {
        return marker;
    }
}

function campiDelContesto(): Record<string, Valore> {
    const c = contesto();
    if (!c) return {};
    return { rid: c.requestId, uid: c.userId, ruolo: c.ruolo, sede: c.scuolaId };
}

function pieno(v: Valore): boolean {
    return v !== undefined && v !== null && v !== '';
}

/**
 * Unisce i campi del chiamante a quelli del contesto, MA il contesto vince: nessun
 * chiamante deve poter falsificare `rid`/`uid`/`ruolo`/`sede` — sono le chiavi con cui
 * si correlano le righe, e una correlazione falsa è peggio di nessuna correlazione.
 * Fuori da una richiesta (cron, boot) lo slot è libero e il chiamante può riempirlo.
 */
function unisci(base: Record<string, Valore>, campi: Record<string, Valore>): Record<string, Valore> {
    const out: Record<string, Valore> = { ...base };
    for (const [k, v] of Object.entries(campi)) {
        if (pieno(out[k])) continue;
        out[k] = v;
    }
    return out;
}

/*
 * UNICO punto del repo autorizzato a scrivere su console.
 *
 * Task 29 attiverà `no-console`: allora — e solo allora — qui andranno i due
 * `eslint-disable-next-line no-console`. Oggi la regola non è attiva e la direttiva
 * verrebbe segnalata come "Unused eslint-disable directive": un warning, che con
 * `--max-warnings 0` fa fallire il gate. (Verificato, non supposto.)
 */
function scriviInfo(riga: string): void {
    console.log(riga);
}

function scriviErrore(v: unknown): void {
    console.error(v);
}

/** Riga di sintesi di una richiesta andata a buon fine. `rt` = risorsa/rotta logica, `n` = conteggio. */
export function logOk(campi: { ms: number; rt?: string; n?: number }): void {
    if (SILENZIOSO || inLogger()) return;
    try {
        scriviInfo(formattaRiga('KV_OK', { ...campiDelContesto(), ...campi }));
    } catch {
        // Un logger che lancia trasforma una 200 in 500: si perde la riga, non la risposta.
    }
}

/**
 * Errore. Emette DUE cose:
 *
 *  1. la riga `KV_ERR` in logfmt, cercabile con `query: "KV_ERR"`;
 *  2. un Error NATIVO, perché lo stack completo e il raggruppamento automatico di Vercel
 *     (`get_runtime_errors` raggruppa per *error name*) funzionano solo con un vero Error.
 *     MAI `JSON.stringify(err)`: su un Error nativo restituisce `{}` — bug già presente
 *     nel repo in api/attendance/daily/route.ts.
 *
 * L'Error nativo emesso NON è quello del chiamante: è la sua copia SANIFICATA. L'originale
 * porta i dati personali dentro il testo (`Key (email)=(mario.rossi@…)`) e dentro l'header
 * dello stack, che di quel testo è una copia. Emetterlo grezzo scavalcherebbe dal basso
 * tutto l'apparato di redazione, proprio nel canale più visibile.
 */
export function logErrore(
    campi: { operazione: string; ms?: number; stato?: number; evento?: string },
    err: unknown,
): void {
    try {
        const d = descriviErrore(err);
        const c = contesto();
        // Un errore Supabase avvolto (`new Error('…', { cause })`) ha il codice sulla CAUSA:
        // senza questo fallback la riga uscirebbe senza il dato più utile che ha.
        const codice = d.codice ?? d.causa?.codice;

        persisti({
            livello: 'error',
            evento: campi.evento ?? 'route',
            messaggio: d.messaggio,
            stack: d.stack,
            codice,
            statoHttp: campi.stato,
            sorgente: 'server',
            contestoExtra: {
                operazione: campi.operazione,
                dettagli: d.dettagli,
                suggerimento: d.suggerimento,
                causa: d.causa,
                // GIÀ redatto da `impostaPayload`: una seconda passata di `redact` riscriverebbe
                // `[redatto:str/40]` come `[redatto:str/16]` e cancellerebbe i marcatori.
                payload: c?.payload,
            },
        });

        if (SILENZIOSO || inLogger()) return;

        scriviErrore(formattaRiga('KV_ERR', {
            ...campiDelContesto(),
            op: campi.operazione,
            evt: campi.evento,
            code: codice,
            stato: campi.stato,
            ms: campi.ms,
            digest: d.digest ?? d.causa?.digest,
            msg: d.messaggio,
            // Come per `code`: in un errore Supabase AVVOLTO (`new Error('…', { cause })`) —
            // la forma più comune nel repo — `details` sta sulla causa, non in cima.
            det: d.dettagli ?? d.causa?.dettagli,
            causa: d.causa?.messaggio,
            payload: c?.payload ? serializza(c.payload, PAYLOAD_MAX) : undefined,
        }));
        scriviErrore(erroreNativo(err, d));
    } catch {
        // Fail-open, sempre.
    }
}

/**
 * Evento di dominio (email, push, cron, config, db, client…).
 *
 * CONTRATTO: `campi` NON accetta dati personali. Sono metadati — provider, esito, stato,
 * durata, conteggi, nome del job — e sulla riga logfmt escono IN CHIARO, perché una riga
 * tutta redatta non serve a nessuno. La riga che va in TABELLA, invece, li fa passare da
 * `redact()`: se un chiamante sbaglia, il dato non si fossilizza nel DB. Il canale volatile
 * (Vercel, ritenzione breve) è leggibile; il canale persistente è difeso.
 *
 * COROLLARIO PRATICO: `redact()` è a lista bianca PER CHIAVE, quindi nella riga persistita
 * sopravvivono in chiaro solo le chiavi note (`tipo`, `stato`, `esito`, `azione`, `operazione`,
 * `provider`, `canale`, `piattaforma`, `evento`, `ambiente`…) più numeri e booleani. Una chiave
 * fuori lista (es. `job: 'solleciti'`) diventa `[redatto:str/9]` in tabella. Chi chiama usi i
 * nomi della lista bianca — o accetti di leggere quel campo solo su Vercel.
 *
 * Il LIVELLO non passa MAI da `redact()`: in questo dominio `livello` è la valutazione delle
 * competenze (D.M. 14/2024, A-D) ed è fra i segreti; redigere l'involucro renderebbe ciechi
 * i log. `redact()` tocca solo ciò che viene dal mondo esterno.
 */
export function logEvento(
    evento: string,
    livello: Livello,
    campi: Record<string, Valore>,
    err?: unknown,
): void {
    try {
        const d = err !== undefined ? descriviErrore(err) : undefined;
        const c = contesto();
        const codice = d?.codice ?? d?.causa?.codice;

        persisti({
            livello,
            evento,
            messaggio: d ? d.messaggio : testoEvento(evento, campi),
            stack: d?.stack,
            codice,
            sorgente: 'server',
            contestoExtra: {
                campi: redact(campi),
                dettagli: d?.dettagli,
                suggerimento: d?.suggerimento,
                causa: d?.causa,
                payload: c?.payload, // già redatto: vedi logErrore
            },
        });

        if (SILENZIOSO || inLogger()) return;

        const riga = unisci({ ...campiDelContesto(), evt: evento }, campi);
        if (d) {
            // Assegnati DOPO l'unione: quando c'è un errore, è l'errore la verità, non i campi.
            if (codice) riga.code = codice;
            riga.msg = d.messaggio;
            if (d.dettagli) riga.det = d.dettagli;
            if (d.causa?.messaggio) riga.causa = d.causa.messaggio;
        }

        const marker = livello === 'error' ? 'KV_ERR' : livello === 'warn' ? 'KV_WARN' : 'KV_EVT';
        const testo = formattaRiga(marker, riga);
        // `console.warn` non c'è, e non è una svista: nelle funzioni non-streaming Vercel lo
        // classifica `error`. Un warn scritto con `console.warn` sporcherebbe il filtro degli errori.
        if (livello === 'info') scriviInfo(testo);
        else scriviErrore(testo);

        if (d) scriviErrore(erroreNativo(err, d));
    } catch {
        // Fail-open, sempre.
    }
}

/** Messaggio della riga persistita quando l'evento non porta un errore: il campo più parlante che c'è. */
function testoEvento(evento: string, campi: Record<string, Valore>): string {
    try {
        const v = [campi.msg, campi.esito, campi.stato].find(pieno);
        return sanificaMessaggio(v === undefined ? evento : String(v));
    } catch {
        return evento;
    }
}

/**
 * La copia sanificata dell'errore, da dare in pasto a `console.error`.
 *
 * Si conserva il NOME dell'originale perché è la chiave con cui Vercel raggruppa gli errori
 * a runtime: appiattire tutto su `Error` renderebbe il raggruppamento inutile. Si conserva
 * lo stack — quello preparato da `descriviErrore`: header sanificato (l'header di V8 È il
 * messaggio, quindi conteneva l'email) e frame intatti (sono path e nomi di funzione).
 * E si conserva la `cause`, sanificata a sua volta: è quasi sempre l'errore vero.
 */
function erroreNativo(err: unknown, d: ErroreDescritto): Error {
    try {
        return daDescrizione(d, nomeDi(err));
    } catch {
        return new Error(d.messaggio);
    }
}

function nomeDi(err: unknown): string | undefined {
    try {
        const n = (err as { name?: unknown } | null | undefined)?.name;
        return typeof n === 'string' && n !== '' ? n : undefined;
    } catch {
        return undefined;
    }
}

function daDescrizione(d: ErroreDescritto, nome?: string): Error {
    const e = new Error(d.messaggio);
    if (nome) e.name = nome;
    // Se l'originale non aveva stack (una stringa lanciata), NON si tiene quello dell'Error
    // appena costruito: punterebbe dentro questo file, indicando il logger come colpevole.
    e.stack = d.stack ?? `${e.name}: ${d.messaggio}`;
    if (d.causa) e.cause = daDescrizione(d.causa);
    return e;
}

/** In tabella va tutto ciò che è warn o error, più i SUCCESSI degli eventi critici. */
export function vaPersistito(livello: Livello, evento: string): boolean {
    return livello === 'error' || livello === 'warn' || EVENTI_PERSISTITI.has(evento);
}

function persisti(riga: RigaLog): void {
    if (SILENZIOSO) return;
    if (!vaPersistito(riga.livello, riga.evento)) return;
    // `entraNelLogger` marca la catena async: se la scrittura su `app_log` fallisce e il suo
    // gestore d'errore logga, `inLogger()` è true e la seconda emissione viene scartata.
    // Senza, si otterrebbe una ricorsione fino all'esaurimento della memoria.
    //
    // Il `.catch` NON è cosmetico: `appLog` è async, e una promise rigettata e non gestita in
    // un runtime serverless è un unhandled rejection — cioè esattamente il crash che questo
    // modulo esiste per non causare.
    void entraNelLogger(() => appLog(riga)).catch(() => {});
}
