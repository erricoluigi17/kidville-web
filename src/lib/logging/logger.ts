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
/**
 * ⚠️ Stesso vincolo di piattaforma di `DIMENSIONE_MAX` in `serialize.ts`, e oggi è cablato
 * in due posti: due costanti indipendenti per lo stesso limite finiranno per divergere.
 * Vanno unificate — richiede però di modificare `serialize.ts`, fuori dal perimetro di
 * questo task.
 */
const LIMITE_RIGA = 3_500;
/** Tetto del singolo campo: un valore impazzito non deve poter sfrattare quelli dopo di lui. */
const CAMPO_MAX = 900;
/** Il payload è l'ultimo campo della riga. Le stringhe le richiude comunque `sanificaMessaggio` (500). */
const PAYLOAD_MAX = 500;

function tronca(s: string, max: number): string {
    if (s.length <= max) return s;
    if (max <= 1) return s.slice(0, Math.max(0, max)); // niente spazio nemmeno per l'ellissi
    return s.slice(0, max - 1) + '…';
}

/**
 * Quota il valore se contiene spazi, `"` o `=` — cioè se senza virgolette la coppia
 * chiave=valore non si rileggerebbe. Gli A CAPO sono nella classe `\s` e vanno quotati
 * per una ragione più forte della leggibilità: un `\n` grezzo SPEZZEREBBE la riga in due
 * voci di log distinte. `JSON.stringify` li rende `\n` letterali. Stessa cosa per i
 * caratteri di controllo, che `\s` non copre tutti.
 */
const DA_QUOTARE = /[\s"=\p{Cc}]/u;

/**
 * Ogni valore STRINGA passa da `sanificaMessaggio`.
 *
 * Non è ridondanza rispetto a `redact()`: sulla riga di Vercel i campi del chiamante escono
 * IN CHIARO per contratto (una riga tutta redatta non serve a nessuno), e quel contratto è
 * l'unico presidio del modulo affidato alla disciplina di 239 chiamanti — su un canale che
 * si legge di continuo. `sanificaMessaggio` non è una lista bianca e non toglie leggibilità
 * (`resend`, `inviata`, `ok` restano tali), ma intercetta email e codici fiscali in QUALUNQUE
 * campo, chiunque li passi: copre l'errore del chiamante, che è il vettore realistico.
 *
 * Il `String(v)` sta dentro il try: `Valore` esclude gli oggetti, ma il logger è chiamato
 * anche da JS non tipizzato, e un `toString` che lancia deve costare QUEL campo.
 * Un oggetto passa da `serializza` — `String({})` direbbe solo `[object Object]`.
 */
function quota(v: unknown): string {
    try {
        let s: string;
        if (typeof v === 'string') s = sanificaMessaggio(v);
        else if (typeof v === 'object' && v !== null) s = sanificaMessaggio(serializza(v, CAMPO_MAX));
        else s = tronca(String(v), CAMPO_MAX);
        return DA_QUOTARE.test(s) ? JSON.stringify(s) : s;
    } catch {
        return '[campo-illeggibile]';
    }
}

/**
 * Le CHIAVI, come i valori, non sono fidate — e sono più pericolose dei valori, perché non
 * vengono quotate: una chiave che contenga un `\n` SPEZZA la riga, e la seconda metà può
 * portarsi dietro un marker. `{ ['x\nKV_OK rid=vittima ms']: 1 }` produrrebbe una riga
 * `KV_OK rid=vittima ms=1` perfettamente indistinguibile da una vera: non un log invisibile,
 * un log che MENTE. Idem per spazi, `=` e virgolette, che sfasano le coppie.
 *
 * Oggi i chiamanti sono letterali nel codice, ma il Task 13 apre `/api/logs` all'ingestione
 * dei log del CLIENT, e `Record<string, Valore>` invita a passarci roba che viene dalla rete.
 * Perciò la chiave si valida qui, una volta, invece di sperare che nessuno sbagli mai.
 */
const CHIAVE_VALIDA = /^[\w.]{1,40}$/;

/**
 * `null`, `undefined` e `''` si OMETTONO: `uid=undefined` occupa spazio e non dice nulla.
 * `0` e `false`, invece, restano: sono informazione ("zero elementi", "non riuscito").
 */
export function formattaRiga(marker: string, campi: Record<string, Valore>): string {
    const coppie: string[] = [];
    let scartate = 0;
    try {
        // `Object.keys`, NON `Object.entries`: entries INVOCA i getter mentre costruisce
        // l'array, quindi un solo getter ostile farebbe saltare l'intera riga — compresi i
        // campi sani. Qui si legge campo per campo, dentro il proprio try: si perde il campo
        // rotto, non la riga. È la stessa disciplina di `redact.ts`, e vale la pena ripeterla
        // perché il modo di sbagliare è identico.
        const oggetto = campi as Record<string, unknown>;
        for (const k of Object.keys(oggetto)) {
            if (!CHIAVE_VALIDA.test(k)) {
                scartate++;
                continue;
            }
            try {
                const v = oggetto[k];
                if (v === undefined || v === null || v === '') continue;
                coppie.push(`${k}=${quota(v)}`);
            } catch {
                coppie.push(`${k}=[campo-illeggibile]`);
            }
        }
        // Un log che tace su ciò che ha buttato è un log che mente (per omissione, stavolta).
        if (scartate > 0) coppie.push(`scartate=${scartate}`);
    } catch {
        // `Object.keys` su un Proxy ostile.
    }
    const riga = coppie.length ? `${marker} ${coppie.join(' ')}` : marker;
    // Il taglio può cadere dentro un valore quotato lasciando una virgoletta spaiata:
    // è accettabile, la riga non viene mai riparsata — viene cercata full-text.
    return tronca(riga, LIMITE_RIGA);
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
    try {
        // `Object.keys` + try per campo, come in `formattaRiga`: qui i getter si invocano
        // per davvero, ed è di nuovo `Object.entries` la trappola.
        const oggetto = campi as Record<string, unknown>;
        for (const k of Object.keys(oggetto)) {
            if (pieno(out[k])) continue;
            try {
                out[k] = oggetto[k] as Valore;
            } catch {
                out[k] = '[campo-illeggibile]';
            }
        }
    } catch {
        // Proxy ostile: restano i campi del contesto, che sono i più importanti.
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

/**
 * Riga di sintesi di una richiesta andata a buon fine. `rt` = rotta logica (il nome che le
 * darà `withRoute`, es. `admin/parents/[id]:GET`), `n` = conteggio degli elementi trattati.
 *
 * Passa da `unisci` come `logEvento`: il contesto vince sempre. Il tipo già impedirebbe un
 * `rid` fra i campi, ma il tipo non protegge da un chiamante JS — e l'invariante "nessuno può
 * falsificare l'id di correlazione" o vale per tutte le porte d'ingresso o non vale.
 */
export function logOk(campi: { ms: number; rt?: string; n?: number }): void {
    if (SILENZIOSO) return;
    try {
        scriviInfo(formattaRiga('KV_OK', unisci(campiDelContesto(), campi)));
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

        if (SILENZIOSO) return;

        // NB: `stato` NON va sulla riga — è lo status HTTP, e Vercel lo conosce già come
        // metadato di piattaforma: sulla riga sarebbe una deroga gratuita alla regola "si
        // logga solo ciò che Vercel non sa". Resta però in TABELLA (`statoHttp`), dove serve
        // a interrogare in SQL senza dover incrociare i log della piattaforma.
        scriviErrore(formattaRiga('KV_ERR', {
            ...campiDelContesto(),
            op: campi.operazione,
            evt: campi.evento,
            code: codice,
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
 * Il contratto però non basta a sé stesso: è l'unico presidio del modulo affidato alla
 * disciplina di 239 chiamanti. Perciò i valori stringa passano comunque da
 * `sanificaMessaggio` (vedi `quota`), che non redige i metadati ma intercetta email e
 * codici fiscali ovunque compaiano. Il contratto resta; la rete sotto anche.
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

        if (SILENZIOSO) return;

        const riga = unisci({ ...campiDelContesto(), evt: evento }, campi);
        if (d) {
            // Assegnati DOPO l'unione: quando c'è un errore, è l'errore la verità, non i campi.
            if (codice) riga.code = codice;
            riga.msg = d.messaggio;
            const det = d.dettagli ?? d.causa?.dettagli;
            if (det) riga.det = det;
            if (d.causa?.messaggio) riga.causa = d.causa.messaggio;
        }

        const marker = livello === 'error' ? 'KV_ERR' : livello === 'warn' ? 'KV_WARN' : 'KV_EVT';
        const testo = formattaRiga(marker, riga);
        // `console.warn` non c'è, e non è una svista: nelle funzioni non-streaming Vercel lo
        // classifica `error`. Un warn scritto con `console.warn` sporcherebbe il filtro degli errori.
        if (livello === 'info') scriviInfo(testo);
        else scriviErrore(testo);

        // L'Error nativo SOLO per `error`. Un Error su console entra nel flusso errori di Vercel
        // e nel raggruppamento di `get_runtime_errors`: emetterlo per un `info` (o per un `warn`,
        // che per definizione non è un guasto) inquinerebbe il filtro degli errori — esattamente
        // il motivo per cui questo modulo rifiuta `console.warn`. Lo stack di un warn non si perde:
        // finisce in tabella (`app_log.stack`), che è dove un warn si va a leggere.
        if (d && livello === 'error') scriviErrore(erroreNativo(err, d));
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
    // Solo se DIVERSO da 'Error': assegnarlo comunque creerebbe una proprietà own enumerabile
    // che `util.inspect` stampa come rumore (`Error: boom { name: 'Error' }`).
    if (nome && nome !== 'Error') e.name = nome;
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

/**
 * La guardia di rientranza sta SOLO qui, non sulle emissioni su console.
 *
 * La ricorsione è possibile su un canale solo: `appLog` fallisce → il suo gestore d'errore
 * logga → si ritenta di scrivere su `app_log` → … `console.log` non richiama il logger, quindi
 * non può ricorrere. Mettere `inLogger()` anche sulle emissioni renderebbe MUTO il fallimento
 * di `app_log` proprio su Vercel — cioè si perderebbe l'unico canale rimasto per accorgersene.
 * Un log ricorsivo abbatte la funzione; un log in più, dentro il logger, è solo un log in più.
 */
function persisti(riga: RigaLog): void {
    if (SILENZIOSO) return;
    if (!vaPersistito(riga.livello, riga.evento)) return;
    if (inLogger()) return;
    // `entraNelLogger` marca la catena async: se la scrittura su `app_log` fallisce e il suo
    // gestore d'errore logga, `inLogger()` è true e la seconda scrittura viene scartata.
    // Senza, si otterrebbe una ricorsione fino all'esaurimento della memoria.
    //
    // Il `.catch` è ridondante OGGI — `entraNelLogger` ingoia già le rejection — ma resta:
    // `appLog` è async e fire-and-forget, e se quel contratto cambiasse (o se `appLog` venisse
    // invocata altrove) una promise rigettata e non gestita in un runtime serverless è un
    // unhandled rejection: esattamente il crash che questo modulo esiste per non causare.
    // Costa una riga; l'alternativa è dipendere da un dettaglio interno di un altro modulo.
    void entraNelLogger(() => appLog(riga)).catch(() => {});
}
