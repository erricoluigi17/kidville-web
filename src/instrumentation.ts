import type { Instrumentation } from 'next';
import { redigiPathSicuro } from '@/lib/logging/path';
import { descriviErrore, sanificaMessaggio } from '@/lib/logging/serialize';

/**
 * La RETE DI SICUREZZA del server, e il PREFLIGHT della configurazione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * DOVE STA QUESTO FILE, e perché è la prima cosa da sapere.
 *
 * In `src/`, NON nella radice. Next calcola la cartella da scandire come `dirname(appDir)`,
 * e qui `appDir = src/app` → scandisce `src/`. Un `instrumentation.ts` messo nella radice
 * viene IGNORATO senza errori e senza warning: il file sembra a posto, il codice sembra
 * scritto, e non logga niente. Che è esattamente il guasto che questo modulo esiste per
 * impedire. Se un giorno l'app router si spostasse, questo file va spostato con lui.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * I DUE RUNTIME. `register` e `onRequestError` girano in OGNI runtime: Node per le route e
 * le pagine, Edge per il middleware. Questo file finisce quindi anche nel bundle dell'Edge
 * (Next lo compila insieme al middleware), e nell'Edge Runtime `node:crypto` non esiste —
 * ma `@/lib/logging/redact` lo importa (`hashCorrelabile`), e da lì lo importano `context`,
 * `logger` e `app-log`. Un import di quei moduli a livello di file trascinerebbe `node:crypto`
 * nel bundle del middleware.
 *
 * La difesa è la guardia `process.env.NEXT_RUNTIME !== 'nodejs'`, e funziona per una ragione
 * precisa: `NEXT_RUNTIME` NON è una lettura a runtime, è una COSTANTE sostituita in fase di
 * compilazione (`getDefineEnv`: `'edge'` nel bundle edge, `'nodejs'` in quello node). Nel
 * bundle dell'edge la condizione diventa `'edge' !== 'nodejs'`, cioè sempre vera: il
 * bundler elimina come codice morto tutto ciò che sta dopo — compresi gli `import()`
 * dinamici di `@/lib/logging/**`. Per questo gli import del logger sono DINAMICI e stanno
 * DENTRO il ramo `nodejs`: statici, non li eliminerebbe nessuno.
 *
 * `@/lib/logging/serialize` e `@/lib/logging/path` invece si importano staticamente, e si può:
 * sono i due moduli del sistema di logging che non importano NIENTE (né `node:crypto` né
 * Supabase). È ciò che rende sanificabile — e riducibile a pattern — anche la riga dell'edge.
 *
 * Regola d'oro, come in tutto `src/lib/logging/**`: NIENTE qui dentro può lanciare.
 * `onRequestError` è il gestore d'errore di ultima istanza — un throw qui sarebbe un errore
 * dentro il gestore degli errori.
 */

/* ════════════════════════════════════════════════════════════════════════════
 * PREFLIGHT DELLA CONFIGURAZIONE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Le variabili la cui assenza produce un guasto SILENZIOSO. È il criterio con cui questa
 * lista è stata scelta, e non è teorico: per mesi nessuna email di credenziali è arrivata a
 * destinazione, e nessun test era rosso. Una `NEXT_PUBLIC_SUPABASE_ANON_KEY` mancante, al
 * contrario, fa esplodere l'app al primo click — non serve un preflight per accorgersene.
 *
 * Ognuna di queste, invece, se manca non rompe niente subito:
 *  · SUPABASE_SERVICE_ROLE_KEY  → le route admin falliscono una per una, a runtime;
 *  · NEXT_PUBLIC_SUPABASE_URL   → idem, e il client di log non si costruisce nemmeno;
 *  · RESEND_API_KEY             → le email non partono. È il guasto storico;
 *  · OTP_FROM_EMAIL             → l'OTP parte da un mittente sbagliato, o non parte;
 *  · CRON_SECRET                → i cron rispondono 401 e nessuno guarda;
 *  · LOG_HASH_SALT              → NON era nel piano, ed è la più insidiosa: senza,
 *    `hashCorrelabile` è fail-closed (vedi `redact.ts`) e ogni identità nei log diventa
 *    `[redatto]`. I log continuano a scriversi, sembrano sani, ma la correlazione
 *    "è sempre lo stesso genitore" è persa — cioè si perde in silenzio proprio la cosa
 *    per cui quell'hash esiste.
 *
 * Lettura con accesso STATICO (`process.env.NOME`), non `process.env[nome]`: le
 * `NEXT_PUBLIC_*` vengono sostituite dal bundler solo sull'accesso statico, e con la forma
 * dinamica il preflight potrebbe gridare al lupo su una variabile che c'è.
 */
function variabiliCritiche(): ReadonlyArray<readonly [string, string | undefined]> {
    return [
        ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
        ['NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL],
        ['RESEND_API_KEY', process.env.RESEND_API_KEY],
        ['OTP_FROM_EMAIL', process.env.OTP_FROM_EMAIL],
        ['CRON_SECRET', process.env.CRON_SECRET],
        ['LOG_HASH_SALT', process.env.LOG_HASH_SALT],
    ];
}

/** Una variabile impostata a stringa vuota è assente: `''` non configura niente. */
function mancante([, valore]: readonly [string, string | undefined]): boolean {
    return valore === undefined || valore.trim() === '';
}

/**
 * Gira UNA VOLTA per processo e per runtime, a ogni cold start.
 *
 * Non fa altro che il preflight: è il momento più presto in cui si può dire "questo deploy
 * nasce già rotto", e dirlo PRIMA che il primo utente incontri il guasto è tutto il punto.
 */
export async function register(): Promise<void> {
    // Vedi la nota sui due runtime in testa al file: da qui in giù è codice che nel bundle
    // dell'edge non esiste proprio. Nell'edge non c'è nulla da verificare — le variabili
    // qui elencate le legge il codice Node — e non ci sarebbe nemmeno con cosa loggarlo.
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    try {
        const { logEvento } = await import('@/lib/logging/logger');

        const ambiente = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'sviluppo';
        const critiche = variabiliCritiche();
        const assenti = critiche.filter(mancante);

        if (assenti.length === 0) {
            // IL SUCCESSO SI LOGGA (AGENTS, regola 5). `config` è in `EVENTI_PERSISTITI`,
            // quindi questa riga finisce in tabella anche a livello `info`: senza, "nessun
            // log di config" non distinguerebbe "tutto a posto" da "il preflight non è mai
            // partito" — cioè dalla stessa ambiguità che ha nascosto il guasto delle email.
            // In tabella non è rumore: la deduplica per (impronta, giorno) la schiaccia in
            // UNA riga al giorno, e `occorrenze` diventa il conteggio dei cold start.
            logEvento('config', 'info', {
                operazione: 'preflight',
                esito: 'ok',
                ambiente,
                n: critiche.length,
            });
            return;
        }

        // AGENTS, regola 4: configurazione mancante = ERROR, mai info. In produzione è un
        // incidente in corso. Fuori dalla produzione (preview, sviluppo locale) è `warn`:
        // resta persistito (`vaPersistito` tiene i warn) e resta visibile, ma non riempie
        // il canale degli errori veri con il rumore di una macchina di sviluppo — dove una
        // `RESEND_API_KEY` assente è la norma, non un guasto.
        const livello = ambiente === 'production' ? 'error' : 'warn';

        // Una riga PER VARIABILE, non una riga con l'elenco: ogni riga ha la sua impronta,
        // quindi in `app_log` si vede esattamente QUALI variabili mancano e da quando.
        for (const [nome] of assenti) {
            // Il nome della variabile DEVE finire in chiaro nella colonna `messaggio`.
            // Non può viaggiare come campo (`mancante: 'RESEND_API_KEY'`): `redact()` è a
            // lista bianca PER CHIAVE, `mancante` non è in lista, e in tabella si leggerebbe
            // `[redatto:str/15]` — un log che dice "manca una variabile" senza dire quale è
            // un log inutile. Il 4° argomento è la via giusta: `descriviErrore` normalizza
            // `{ message, code }` in messaggio + codice, che sono DUE COLONNE vere di
            // `app_log` — sanificate, ma in chiaro. E il `codice` rende interrogabile in SQL
            // "dammi tutte le configurazioni mancanti".
            logEvento('config', livello, { operazione: 'preflight', esito: 'mancante', ambiente }, {
                message: `variabile d'ambiente critica mancante: ${nome}`,
                code: 'config_mancante',
            });
        }
    } catch {
        // Fail-open: un preflight che esplode non deve impedire l'avvio del processo.
    }
}

/* ════════════════════════════════════════════════════════════════════════════
 * onRequestError — CIÒ CHE `withRoute` NON PUÒ VEDERE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * `withRoute` avvolge gli export HTTP delle route, e quindi vede una cosa sola: le eccezioni
 * che nascono DENTRO l'handler. Tutto il resto del server gli è invisibile per costruzione:
 *
 *  · il render di una pagina o di un Server Component (`routeType: 'render'`);
 *  · una Server Action (`'action'`);
 *  · il middleware (`'proxy'`, e gira nell'Edge);
 *  · gli errori sollevati FUORI dall'handler — risoluzione dei `params`, serializzazione
 *    della `Response`, un throw nel wrapper stesso.
 *
 * `onRequestError` è l'unica rete sotto tutto questo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DOPPIONE: accettato, e per iscritto.
 *
 * Un'eccezione che sfugge a una route avvolta produce DUE righe: `withRoute` la logga con
 * `logErrore` (evento `route`) e la RILANCIA — poi Next la cattura e chiama noi (evento
 * `unhandled`). Si è scelto di non sopprimerla, per tre ragioni:
 *
 *  1. Non sono la stessa riga. Quella di `withRoute` ha il nome LOGICO della rotta, il
 *     payload validato e l'identità depositata dal gate. La nostra ha ciò che solo Next
 *     conosce: `routePath`, `routeType`, il `digest` — il numero che l'utente legge sulla
 *     schermata d'errore e che è l'unico appiglio quando ci scrive.
 *  2. `unhandled` è una METRICA: conta gli errori che escono dall'handler, e deve tendere a
 *     zero (il pattern del repo è `catch → logErrore → 500`, che NON passa di qui). Se le due
 *     righe si fondessero, il conteggio non esisterebbe più.
 *  3. Sopprimerla non si potrebbe fare "bene": la marca `erroreLoggato` vive nel contesto
 *     `AsyncLocalStorage` aperto da `withRoute`, e quando Next chiama `onRequestError`
 *     l'eccezione è già USCITA da `als.run` — lo store non è più visibile. Servirebbe uno
 *     stato condiviso fra `logger.ts` e questo file (una WeakSet degli errori già loggati):
 *     stato globale nel logging, per risparmiare una riga sul percorso più raro che c'è.
 *     Cattivo affare.
 *
 * Le due righe si ritrovano comunque: stesso `request_id` ogni volta che l'id arriva DA FUORI
 * (`x-request-id` del client, o `x-vercel-id` che mette la piattaforma) — la stessa catena di
 * ripiego di `withRoute`, nello stesso ordine, apposta.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
    try {
        // Nell'Edge (middleware) il logger non è caricabile: niente `node:crypto`, niente
        // client Supabase, niente `app_log`. Resta la riga su console — che non è poco: se
        // il middleware si rompe, TUTTE le navigazioni cadono, e una ricerca `KV_ERR` che
        // non trovasse nulla direbbe che l'app sta benissimo mentre è giù.
        if (process.env.NEXT_RUNTIME !== 'nodejs') {
            rigaEdge(err, request, context);
            return;
        }

        const { conContesto } = await import('@/lib/logging/context');
        const { logEvento } = await import('@/lib/logging/logger');

        // Si APRE un contesto attorno all'emissione. Non è cerimonia: `onRequestError` viene
        // chiamata FUORI dal contesto di `withRoute` (l'eccezione è uscita da `als.run`),
        // quindi senza questo `conContesto` la riga in `app_log` avrebbe `route`, `request_id`
        // e ogni campo di correlazione a NULL — e una riga d'errore che non dice quale
        // richiesta è morta serve a poco.
        //
        // `conContesto` fa anche due cose che qui contano più che altrove:
        //  · normalizza il requestId (è INPUT DEL CLIENT: un `\n` dentro sarebbe una riga di
        //    log falsa, scritta da chi fa la richiesta);
        //  · riduce il path a PATTERN con `redigiPath`. `request.path` è l'url grezzo, CON la
        //    query string: in questo repo trasporta `?userId=`, `?token=`, `?email=`, e il
        //    path stesso è una capability (`/m/<token>`). Grezzo nei log sarebbe una
        //    credenziale nei log.
        //
        // NB: l'identità (`utente_id`) resta VUOTA, ed è voluto. Il piano la leggeva da un
        // header (`x-kv-user`): un header è input del client, e `app_log.utente_id` è la
        // colonna con cui si risponde a "quali errori ha visto QUESTO utente". Un valore
        // forgiabile lì dentro attribuirebbe un guasto a un innocente — un log che mente è
        // peggio di un log che manca.
        await conContesto({ requestId: requestId(request.headers), path: request.path }, async () => {
            logEvento(
                'unhandled',
                'error',
                {
                    // `operazione`, non `rt`: è la chiave che sopravvive alla lista bianca di
                    // `redact` (in tabella `rt` sarebbe `[redatto:str/24]`, cioè la riga non
                    // direbbe più QUALE rotta è morta). Sulla riga di Vercel la rinomina
                    // `logEvento` in `rt=`. Vedi la doc in testa a `logger.ts`.
                    operazione: context.routePath,
                    // 'render' | 'route' | 'action' | 'proxy': dice se è morta una PAGINA o una
                    // route, che è la prima domanda che ci si fa. `tipo` è in lista bianca.
                    tipo: context.routeType,
                    metodo: request.method,
                    // IL DIGEST È LA CHIAVE CHE CHIUDE IL CERCHIO, e qui è l'unico posto che ce
                    // l'ha. `error.tsx` lo mostra all'utente come «il codice da dare alla
                    // segreteria»: è l'unico numero che un genitore ha in mano quando telefona.
                    // Questo gestore è l'unico che vede lo STACK VERO di un errore di render.
                    // I due si incontrano solo se il digest arriva in chiaro fino in tabella.
                    //
                    // E ci arriva: `digest` è in `CHIAVI_DIGEST` (redact.ts), con la stretta che
                    // rende la deroga difendibile — LA CHIAVE APRE, IL VALORE CONFERMA: passa solo
                    // ciò che ha FORMA di digest (esadecimale, 4-64 caratteri, `DIGEST_PLAUSIBILE`).
                    // Serve perché `redact` gira anche sul body grezzo delle richieste: senza il
                    // controllo sul valore, una POST con `{"digest": "<testo libero>"}` avrebbe
                    // aperto un canale in chiaro verso `app_log`. Fuori forma → redatto, e la
                    // correlazione si perde: fail-closed, come dev'essere.
                    //
                    // In SQL, quindi, il codice letto dall'utente si cerca DIRETTAMENTE — e la
                    // riga che ha lo stack è a un `where` di distanza:
                    //   select * from app_log where contesto->'campi'->>'digest' = '<codice>';
                    // (`->'campi'` e non `->>'digest'` in cima: `logEvento` annida i campi del
                    // chiamante sotto `campi`, vedi `contestoExtra` in logger.ts.)
                    digest: digestDi(err),
                },
                // Il 4° argomento: `logEvento` fa già DA SÉ le due emissioni che servono —
                // la riga logfmt `KV_ERR` e l'Error NATIVO su console (che è ciò su cui Vercel
                // raggruppa gli errori a runtime). E l'Error che emette è la copia SANIFICATA
                // (`erroreNativo` → `daDescrizione`): l'header dello stack di V8 È il messaggio,
                // quindi l'originale può portarsi dentro un'email. Rifare a mano `formattaRiga`
                // + `console.error(err)` — come nel piano — significherebbe duplicare due
                // logiche delicate e, sull'errore grezzo, scavalcare dal basso tutta la
                // redazione proprio nel canale più visibile.
                err,
            );
        });
    } catch {
        // L'ultima rete di tutte. Un throw nel gestore degli errori non ha nessuno che lo
        // raccolga: si perde la riga, non il processo.
    }
};

/* ────────────────────────────────────────────────────────────────────────────
 * LA RIGA DELL'EDGE (middleware).
 *
 * Qui questo file duplica UNA sola cosa del logger — la formattazione logfmt — e la
 * duplicazione è la conseguenza di un vincolo di piattaforma, non una scelta: `formattaRiga`
 * sta in `logger.ts`, che per import transitivo tira dentro `node:crypto` (via `redact.ts`),
 * e l'Edge Runtime non lo espone.
 *
 * La riduzione del path, invece, NON è più duplicata: viveva qui come copia a mano di
 * `redigiPath`, e ora arriva da `@/lib/logging/path` — un modulo senza import, caricabile
 * anche dall'Edge. Una copia che divergeva in silenzio in meno.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Quota il valore se senza virgolette la coppia `chiave=valore` non si rileggerebbe. Gli a
 * capo sono il caso serio, non un dettaglio di stile: un `\n` grezzo spezzerebbe la riga in
 * DUE voci di log, e la seconda metà potrebbe portarsi dietro un marker — un log che mente.
 * Come in `logger.ts`, ogni stringa passa prima da `sanificaMessaggio`: qui non c'è una
 * chiave su cui applicare la lista bianca, e un messaggio d'errore può contenere un'email.
 */
const DA_QUOTARE = /[\s"=\p{Cc}]/u;

function coppia(chiave: string, valore: string | undefined): string | undefined {
    if (valore === undefined || valore === '') return undefined;
    const s = sanificaMessaggio(valore);
    return `${chiave}=${DA_QUOTARE.test(s) ? JSON.stringify(s) : s}`;
}

function rigaEdge(
    err: unknown,
    request: Readonly<{ path: string; method: string }>,
    context: Readonly<{ routePath: string; routeType: string }>,
): void {
    try {
        const d = descriviErrore(err);
        const campi = [
            coppia('evt', 'unhandled'),
            coppia('rt', context.routePath),
            coppia('tipo', context.routeType),
            coppia('metodo', request.method),
            // Sulla riga di Vercel il path di solito non si logga (la piattaforma lo conosce
            // già). Qui sì: nell'Edge non c'è nessuna tabella in cui finisca la colonna
            // `route`, e senza il path la riga non direbbe QUALE navigazione è caduta.
            coppia('path', redigiPathSicuro(request.path)),
            coppia('code', d.codice ?? d.causa?.codice),
            coppia('msg', d.messaggio),
            coppia('causa', d.causa?.messaggio),
        ].filter((c): c is string => c !== undefined);

        // `console.error` e non `console.warn`: nelle funzioni non-streaming Vercel classifica
        // `warn` come `error` comunque, e il livello lo si sceglie una volta sola, in `logger.ts`.
        // Qui non si emette l'Error nativo: costruirne una copia sanificata richiederebbe di
        // duplicare anche `daDescrizione`, e l'eccezione dell'edge Vercel la riporta già di suo
        // con il suo stack. Questa riga aggiunge il marker e i metadati, che è ciò che manca.
        console.error(['KV_ERR', ...campi].join(' '));
    } catch {
        // Fail-open, come ovunque nel logging.
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Letture difensive degli argomenti di Next.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `request.headers` porta anche i COOKIE DI SESSIONE. Si legge per ALLOWLIST di chiavi — mai
 * l'oggetto intero, mai un ciclo su tutte le intestazioni: il giorno in cui qualcuno logga
 * `headers` "per comodità", il token di sessione di un genitore finisce in `app_log`.
 *
 * Le due chiavi, in QUEST'ORDINE, sono le stesse di `withRoute`: è ciò che fa correlare la
 * riga del wrapper e la nostra quando l'id arriva da fuori. `x-vercel-id` lo mette la
 * piattaforma su ogni richiesta, quindi in produzione un id c'è sempre.
 */
function requestId(headers: NodeJS.Dict<string | string[]>): string {
    return intestazione(headers, 'x-request-id') ?? intestazione(headers, 'x-vercel-id') ?? '';
}

function intestazione(headers: NodeJS.Dict<string | string[]>, nome: string): string | undefined {
    try {
        const v = headers?.[nome];
        const s = Array.isArray(v) ? v[0] : v;
        return typeof s === 'string' && s !== '' ? s : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Il `digest` che Next appiccica agli errori del server: è il numero mostrato all'utente
 * nella schermata d'errore, e l'unico appiglio quando ce lo riporta. Letto in modo difensivo
 * perché `err` è `unknown`: può essere una stringa, `null`, o un oggetto con un getter ostile.
 */
function digestDi(err: unknown): string | undefined {
    try {
        const d = (err as { digest?: unknown } | null | undefined)?.digest;
        return typeof d === 'string' && d !== '' ? d : undefined;
    } catch {
        return undefined;
    }
}
