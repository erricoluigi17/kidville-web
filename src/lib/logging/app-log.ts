import { createHash, randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { contesto, entraNelLogger, inLogger } from './context';
import { serializza } from './serialize';
import { logEvento } from './logger';
import { createLogClient } from '../supabase/server-client';

/**
 * Il SINK: la riga strutturata che finisce nella tabella `app_log`.
 *
 * PERCHÉ ESISTE. Su Vercel Pro i Runtime Logs hanno una ritenzione di UN GIORNO e non si
 * interrogano in SQL. `app_log` è la memoria lunga (30 giorni) e l'unica superficie su cui si
 * può chiedere "quante volte ha fallito questa route", "questo errore è nuovo o va avanti da
 * una settimana", "quanti utenti ha colpito". I due canali non sono ridondanti: hanno budget,
 * vita e forma diversi.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LE TRE REGOLE, in ordine di importanza:
 *
 *  1. NON LANCIA MAI, e non rigetta mai. È chiamata fire-and-forget dal logger, dentro le
 *     239 route: un throw qui trasformerebbe una 200 in 500. Ogni ramo è avvolto.
 *  2. NON RICORRE MAI. Se la scrittura su `app_log` fallisce e il gestore d'errore logga,
 *     si tenterebbe di riscrivere su `app_log` → ricorsione fino all'OOM. Tre difese
 *     indipendenti, sotto.
 *  3. NON BLOCCA. La riga si scrive dopo la risposta (`after()`), non prima.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * LE TRE DIFESE CONTRO LA RICORSIONE (una sola non basta: qui l'errore è un OOM in produzione)
 *
 *  a. `createLogClient()` è l'UNICO client Supabase senza fetch strumentato. La chiamata a
 *     `app_log_registra` non passa da `supabase-fetch.ts`, quindi il suo eventuale 4xx non
 *     genera un `logEvento` di suo. È la difesa STRUTTURALE: il ciclo non esiste proprio.
 *  b. `entraNelLogger()` marca la catena async. Se qualcosa qui dentro logga, `persisti()` in
 *     `logger.ts` vede `inLogger()` e scarta la riga. Copre il caso in cui un domani qui si
 *     usasse un client normale.
 *  c. Il gestore d'errore chiama `logEvento(..., { persisti: false })` — la valvola che
 *     `logger.ts` documenta esattamente per questo caso: emetti su console, NON in tabella.
 *
 * E il fallimento resta VISIBILE: la riga esce comunque su console (Vercel). È l'unico canale
 * da cui ci si accorgerebbe che i log non si scrivono più; renderlo muto per prudenza
 * significherebbe non saperlo mai.
 */

/**
 * Riga destinata alla TABELLA `app_log` (non a Vercel).
 *
 * Sono due canali con budget e vita diversi: su Vercel finisce una riga corta e
 * cercabile (marker + logfmt), qui finisce la riga strutturata e interrogabile in SQL.
 * Chi scrive qui dentro ha già fatto passare tutto da `redact`/`sanificaMessaggio`:
 * questa interfaccia non redige nulla per conto proprio.
 */
export interface RigaLog {
    livello: 'info' | 'warn' | 'error';
    evento: string;
    messaggio: string;
    stack?: string;
    codice?: string;
    statoHttp?: number;
    sorgente?: 'server' | 'client';
    piattaforma?: 'web' | 'ios' | 'android';
    contestoExtra?: Record<string, unknown>;
}

/**
 * Stessa guardia di `logger.ts`, e non è un doppione ozioso: `logger.persisti()` copre le
 * chiamate CHE PASSANO DAL LOGGER, ma `appLog` è anche l'ingresso diretto dei log del CLIENT
 * (`/api/logs`, Task 13), che nei test viene invocato come una route qualunque. E `.env.local`
 * punta al DB di PRODUZIONE: una suite che scrive righe di log in produzione è un incidente,
 * non un test. Valutata UNA VOLTA al caricamento del modulo — `NODE_ENV` viene stubbato a
 * 'production' da `__tests__/api/p0-gates.test.ts`, quindi non è affidabile.
 */
const SILENZIOSO = !!process.env.VITEST || process.env.KV_LOG_LEVEL === 'silent';

/**
 * CIRCUIT BREAKER. Il DB usato dagli E2E in CI è un progetto Supabase SEPARATO che non viene
 * MAI migrato (vedi la memoria `e2e_ci_db_migration_drift`): lì `app_log` e la sua RPC non
 * esistono. Senza il breaker, OGNI log tenterebbe una scrittura destinata a fallire — e ogni
 * fallimento emette una riga d'errore su console: i log della CI diventerebbero illeggibili
 * proprio nel momento in cui servono a capire perché un E2E è rosso.
 *
 * SI APRE SOLO SU SCHEMA MANCANTE. Mai su un errore transitorio: un blip di rete o un 503
 * spegnerebbero il logging fino al prossimo deploy — cioè proprio durante l'incidente che i
 * log dovrebbero raccontare. Un guasto transitorio si ritenta al log successivo; una tabella
 * che non esiste non comparirà da sola.
 *
 * È una variabile di MODULO, quindi vive quanto il processo (su Fluid Compute più richieste
 * condividono lo stesso processo Node): è voluto. Il breaker è per-processo — al deploy
 * successivo, o su una lambda fredda, si richiude da solo, che è esattamente il momento in cui
 * lo schema può essere cambiato. Non tiene dati di richiesta: nessuna contaminazione fra utenti.
 */
let schemaMancante = false;

/**
 * Codici di "schema mancante".
 *
 * `PGRST202` NON era nel piano ed è il più importante di tutti: qui si chiama una RPC, e
 * quando una FUNZIONE non è nella schema cache PostgREST risponde 404 con PGRST202 — non con
 * PGRST205 (tabella) né con 42P01 (che arriva solo se la funzione esiste ma tocca una tabella
 * che non c'è). Sul DB E2E, dove la migrazione non è mai passata, PGRST202 è il codice che
 * si riceve davvero.
 */
const CODICI_SCHEMA_MANCANTE = new Set([
    '42P01', // undefined_table
    '42703', // undefined_column
    'PGRST200', // relazione referenziata inesistente
    'PGRST202', // funzione non trovata nella schema cache  ← il caso vero della CI
    'PGRST204', // colonna non trovata nella schema cache (INSERT/UPDATE)
    'PGRST205', // tabella non trovata nella schema cache
]);

/**
 * Ripiego TESTUALE: PostgREST non popola sempre `code` (lo stesso ripiego è in
 * `src/app/api/notifiche/promemoria/route.ts:31`, dove è stato pagato con un guasto).
 *
 * È volutamente STRETTO. Nessun errore transitorio parla così: un timeout è `fetch failed`,
 * un 503 è `Service Unavailable`, un DB in affanno è `canceling statement due to statement
 * timeout`. Nessuno dei tre incrocia queste tre frasi — che è il requisito, perché aprire il
 * breaker su un guasto passeggero significherebbe spegnere i log fino al prossimo deploy.
 */
const TESTO_SCHEMA_MANCANTE = /does not exist|schema cache|could not find/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PIATTAFORME = new Set(['web', 'ios', 'android']);

/** Tetto del `contesto` jsonb. Il troncamento vero lo rifà anche la RPC: qui si risparmia banda. */
const CONTESTO_MAX = 8_000;
/** Tetto del singolo campo quando il contesto intero non ci sta e va ricostruito pezzo per pezzo. */
const CONTESTO_CAMPO_MAX = 2_000;

/**
 * Quanti frame dello stack entrano nell'impronta.
 *
 * TRE, e il numero è un compromesso misurato: con ZERO frame due errori con lo stesso messaggio
 * ma nati in punti diversi del codice collasserebbero in una riga sola (e lo stack conservato
 * sarebbe quello sbagliato); con TUTTI, un errore che risale da profondità diverse dello stesso
 * stack produrrebbe righe distinte e il conteggio non aggregherebbe più niente.
 */
const FRAME_IMPRONTA = 3;

const FRAME = /^\s*at\s/;

/**
 * Scrive la riga in tabella. Fire-and-forget: il chiamante (`persisti`, in `logger.ts`) non
 * aspetta, e non deve aspettare — l'osservabilità non sta sul percorso critico della risposta.
 */
export async function appLog(riga: RigaLog): Promise<void> {
    if (SILENZIOSO) return;
    // Il breaker si controlla PRIMA di tutto: se lo schema non c'è, non si costruisce nemmeno
    // il client. Su un E2E questo è il ramo che gira migliaia di volte.
    if (schemaMancante) return;

    try {
        const esegui = (): Promise<void> => {
            const scrittura = scrivi(riga);
            mantieniViva(scrittura);
            return scrittura;
        };

        // `entraNelLogger` NON è rientrante: chiamato quando `inLogger()` è già vero
        // restituisce `undefined` senza eseguire `fn` — cioè annullerebbe la scrittura.
        // Quando si arriva da `logger.persisti()` la catena è GIÀ marcata: si scrive e basta.
        if (inLogger()) {
            await esegui();
            return;
        }
        // Chiamata diretta (il Task 13 apre `/api/logs` ai log del client): qui la marca non
        // c'è ancora e la mette questo modulo, che è l'ultimo punto in cui si può fare.
        await entraNelLogger(esegui);
    } catch {
        // Niente nel logging può lanciare. `scrivi` è già fail-open per costruzione, e
        // `entraNelLogger` non rigetta mai: questo try è la rete sotto la rete.
    }
}

/**
 * Tiene viva l'invocazione finché la scrittura non è arrivata al DB.
 *
 * `appLog` è async e fire-and-forget: su Vercel la lambda può CONGELARSI appena la risposta è
 * partita, e l'insert in volo muore lì. `after()` è l'API che Next espone proprio per questo
 * (registra un lavoro da completare DOPO la risposta).
 *
 * FUORI DA UN CONTESTO DI RICHIESTA `after()` LANCIA (verificato: «`after` was called outside a
 * request scope») — succede nei cron invocati fuori da una route, negli script e nei test. Si
 * ignora, e non si perde niente: la promise è già partita (`scrivi` è chiamata PRIMA di qui) e
 * lì non c'è nessuna lambda che possa congelarsi. Il throw è sincrono, quindi il try lo prende.
 */
function mantieniViva(scrittura: Promise<unknown>): void {
    try {
        after(scrittura);
    } catch {
        // Nessun contesto di richiesta: vedi sopra.
    }
}

/** Non rigetta MAI: ogni fallimento esce su console e si ferma qui. */
async function scrivi(riga: RigaLog): Promise<void> {
    try {
        const supabase = await createLogClient();
        const { error } = await supabase.rpc('app_log_registra', { righe: [componi(riga)] });
        if (!error) return;

        if (schemaAssente(error)) {
            schemaMancante = true;
            // `warn` e non `error`: su un DB non migrato (la CI) non è un guasto, è una
            // configurazione. Una riga sola per processo — poi il breaker tace.
            segnala('warn', 'schema-assente', error);
            return;
        }

        segnala('error', 'fallito', error);
    } catch (err) {
        // Ci si arriva con un errore di RETE (il fetch di supabase-js lancia) o con un
        // `createLogClient` che esplode per una env var mancante.
        segnala('error', 'eccezione', err);
    }
}

/**
 * L'unico posto da cui si può sapere che i log non si scrivono più.
 *
 * `{ persisti: false }` è la valvola documentata in `logger.ts`: emetti su console, NON in
 * tabella. Non ha senso scrivere su `app_log` per dire che `app_log` non si scrive — la
 * scrittura fallirebbe di nuovo, e sarebbe il primo giro di una ricorsione. È la difesa (c);
 * la (b) (`inLogger()`) copre lo stesso caso da sola, e va bene così: qui una difesa sola vuol
 * dire OOM in produzione.
 *
 * `operazione` ed `esito` sono chiavi della LISTA BIANCA di `redact`: escono in chiaro. Non
 * conta per la tabella (non ci arriviamo), conta perché `sanificaMessaggio` gira comunque su
 * ogni valore della riga.
 */
function segnala(livello: 'warn' | 'error', esito: string, err: unknown): void {
    try {
        logEvento('app_log', livello, { operazione: 'app_log_registra', esito }, err, {
            persisti: false,
        });
    } catch {
        // Fail-open: si perde la segnalazione, non la richiesta.
    }
}

/**
 * Lo schema non c'è. Distinto con cura da "il DB non risponde": il primo è permanente e va
 * assorbito una volta sola, il secondo è transitorio e il log successivo deve riprovarci.
 */
function schemaAssente(err: unknown): boolean {
    try {
        const e = err as { code?: unknown; message?: unknown } | null | undefined;
        if (typeof e?.code === 'string' && CODICI_SCHEMA_MANCANTE.has(e.code)) return true;
        return typeof e?.message === 'string' && TESTO_SCHEMA_MANCANTE.test(e.message);
    } catch {
        // Getter ostile: nel dubbio il breaker NON si apre. Sbagliare tenendo il logging
        // acceso costa qualche riga d'errore; sbagliare spegnendolo costa la cecità.
        return false;
    }
}

/**
 * La riga come la vuole la RPC: chiavi in snake_case, uguali ai nomi delle colonne.
 *
 * I campi di CORRELAZIONE (route, utente, sede, request id) NON stanno in `RigaLog`: il logger
 * non li passa, li si legge qui dal contesto. È l'unico modo per garantire che siano quelli
 * VERI — un chiamante non deve poterli falsificare (stessa invariante di `unisci` in
 * `logger.ts`), e `contesto().path` è già ridotto a pattern da `redigiPath` (in questo repo il
 * path è una credenziale).
 */
function componi(riga: RigaLog): Record<string, unknown> {
    const c = contesto();

    const livello = riga.livello;
    const evento = testo(riga.evento) ?? 'sconosciuto';
    const sorgente = riga.sorgente === 'client' ? 'client' : 'server';
    const messaggio = testo(riga.messaggio) ?? '';
    const stack = testo(riga.stack);
    const codice = testo(riga.codice);
    const route = testo(c?.path);
    const statoHttp = intero(riga.statoHttp);
    const utenteId = comeUuid(c?.userId);
    const scuolaId = comeUuid(c?.scuolaId);

    return {
        livello,
        evento,
        sorgente,
        messaggio,
        stack,
        codice,
        route,
        stato_http: statoHttp,
        utente_id: utenteId,
        utente_ruolo: testo(c?.ruolo),
        scuola_id: scuolaId,
        request_id: testo(c?.requestId),
        piattaforma: PIATTAFORME.has(riga.piattaforma ?? '') ? riga.piattaforma : undefined,
        app_versione: testo(process.env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 7),
        ambiente: testo(process.env.VERCEL_ENV) ?? testo(process.env.NODE_ENV) ?? 'sviluppo',
        fingerprint: impronta({
            sorgente, livello, evento, route, codice, statoHttp, utenteId, messaggio, stack,
        }),
        contesto: contestoJson(riga.contestoExtra),
    };
}

interface Identita {
    sorgente: string;
    livello: string;
    evento: string;
    route?: string;
    codice?: string;
    statoHttp?: number;
    utenteId?: string;
    messaggio: string;
    stack?: string;
}

/**
 * L'IMPRONTA: due occorrenze dello stesso guasto devono SOMMARSI in una riga, non moltiplicarsi
 * in due. Il moltiplicatore di volume non sono le 239 route — è il CLIENT: una WebView su rete
 * mobile degradata produce decine di migliaia di errori identici in un'ora, e senza deduplica
 * sarebbero decine di migliaia di righe.
 *
 * COSA C'È DENTRO, e perché ognuno:
 *
 *  - `livello`, `evento`, `messaggio`, i primi frame dello stack → il piano li chiedeva, e sono
 *    l'identità dell'errore.
 *  - `route` → NON era nel piano, ed è necessario: in `logErrore` il nome della rotta sta in
 *    `contestoExtra`, non nel messaggio. Senza, due route diverse che falliscono con lo stesso
 *    messaggio ("Errore interno") collasserebbero in UNA riga, e la colonna `route` di quella
 *    riga direbbe il nome della prima — cioè MENTIREBBE. Una colonna che mente è peggio di una
 *    colonna che manca.
 *  - `codice`, `stato_http` → stesso argomento: sono colonne della riga, e devono descriverla.
 *  - `utente_id` → il piano chiede un indice `(utente_id, visto_l_ultima desc)`. Senza l'utente
 *    nell'impronta quell'indice è inservibile: la riga porterebbe l'id del PRIMO utente che ha
 *    incrociato l'errore, e "tutti i log dell'utente X" non troverebbe nulla. Il costo in volume
 *    è limitato e noto: al massimo una riga per (errore × utente colpito × giorno) — con una
 *    sede sola e qualche centinaio di famiglie sono centinaia di righe al giorno nel caso
 *    pessimo, contro le decine di migliaia che il dedup evita. La tempesta del client resta
 *    schiacciata: mille errori dello stesso utente restano UNA riga con `occorrenze = 1000`.
 *
 * COSA NON C'È: `request_id`, `scuola_id`, `contesto`, e lo `stack` completo. Su una riga
 * deduplicata quei campi sono il CAMPIONE della prima occorrenza, non l'insieme — ed è scritto
 * anche nel commento della migrazione, perché è l'unica cosa che chi legge in SQL deve sapere
 * per non trarre conclusioni sbagliate. La traccia per-richiesta resta su Vercel (un giorno);
 * `app_log` è la memoria di COSA si è rotto e QUANTO, non di ogni singola richiesta.
 *
 * LA FINESTRA: il GIORNO non è qui dentro, è la colonna `giorno` — vedi la migrazione. Con
 * un'impronta globale su tutto il tempo (il piano) un errore di 29 giorni fa e uno di oggi
 * cadrebbero nella stessa riga, e la purge a 30 giorni non cancellerebbe mai una riga che
 * continua a ripresentarsi: `occorrenze` diventerebbe un contatore a vita, incapace di
 * rispondere alla domanda operativa vera ("è peggiorato oggi?"). Tenendo l'impronta STABILE nel
 * tempo e mettendo il giorno nella chiave unica `(fingerprint, giorno)` si ottengono entrambe
 * le cose: `occorrenze` è il conteggio del giorno, e `group by fingerprint` aggrega la storia.
 */
function impronta(id: Identita): string {
    try {
        const parti = [
            id.sorgente, id.livello, id.evento, id.route ?? '', id.codice ?? '',
            id.statoHttp === undefined ? '' : String(id.statoHttp), id.utenteId ?? '',
            id.messaggio, frameDi(id.stack),
        ];
        // ` ` come separatore: nessuno dei campi può contenerlo (passano tutti da
        // `sanificaMessaggio`/`redigiPath`), quindi due composizioni diverse non possono
        // produrre la stessa concatenazione.
        return createHash('sha256').update(parti.join(' ')).digest('hex');
    } catch {
        // Un'impronta VUOTA farebbe collassare in una riga sola guasti che non c'entrano nulla
        // fra loro (la chiave unica è proprio questa). Nel dubbio si genera un valore unico:
        // si perde la deduplica di QUESTA riga, non la verità di tutte le altre.
        return (randomUUID() + randomUUID()).replace(/-/g, '');
    }
}

/** I primi frame: l'header dello stack È il messaggio (già in `messaggio`), e non va contato due volte. */
function frameDi(stack: string | undefined): string {
    if (stack === undefined) return '';
    try {
        return stack.split('\n').filter((r) => FRAME.test(r)).slice(0, FRAME_IMPRONTA).join('\n');
    } catch {
        return '';
    }
}

/**
 * `contestoExtra` → jsonb. NON si redige (chi scrive la riga ha già redatto: una seconda passata
 * riscriverebbe `[redatto:str/40]` come `[redatto:str/16]` e cancellerebbe i marcatori). Qui si
 * fa solo una cosa: garantire che sia JSON valido e limitato.
 *
 * `serializza` non lancia mai e tronca da sé — ma una stringa TRONCATA non è più JSON valido, e
 * un `JSON.parse` su di essa lancerebbe. Perciò si misura prima (`+ 1`, come `impostaPayload` in
 * `context.ts`) e, se non ci sta, si ricostruisce campo per campo: si perde il campo grosso, non
 * tutto il contesto.
 */
function contestoJson(extra: Record<string, unknown> | undefined): Record<string, unknown> {
    if (extra === undefined || extra === null) return {};
    try {
        const s = serializza(extra, CONTESTO_MAX + 1);
        if (s.length <= CONTESTO_MAX) {
            const v: unknown = JSON.parse(s);
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                return v as Record<string, unknown>;
            }
        }
    } catch {
        // Due modi di arrivare qui, e nessuno dei due deve costare il contesto INTERO:
        //  · la stringa è stata troncata (JSON valido tagliato a metà → `JSON.parse` lancia);
        //  · un GETTER OSTILE ha fatto lanciare `JSON.stringify`, e `serializza` è ripiegato
        //    su `String(v)` — cioè `'[object Object]'`, che non è JSON.
        // In entrambi i casi si ricostruisce campo per campo: si perde il campo rotto (o
        // quello gigante), non tutta la riga. È la stessa disciplina di `redact.ts`.
    }
    return perCampo(extra);
}

function perCampo(extra: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    try {
        for (const k of Object.keys(extra)) {
            try {
                const v = extra[k];
                if (v === undefined) continue;
                const s = serializza(v, CONTESTO_CAMPO_MAX + 1);
                out[k] = s.length > CONTESTO_CAMPO_MAX ? '[troppo-grande]' : JSON.parse(s);
            } catch {
                out[k] = '[campo-illeggibile]';
            }
        }
    } catch {
        // Proxy ostile su `Object.keys`. Un log che tace su ciò che ha perso è un log che
        // mente: si dice che il contesto c'era e non si è potuto leggere.
        out['[contesto-illeggibile]'] = true;
    }
    return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Letture difensive. Il logger è chiamato anche da JS non tipizzato: qui dentro
 * `riga.livello` può essere qualunque cosa.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Stringa non vuota, o `undefined` (che `JSON.stringify` omette → NULL in colonna). */
function testo(v: unknown): string | undefined {
    try {
        return typeof v === 'string' && v !== '' ? v : undefined;
    } catch {
        return undefined;
    }
}

function intero(v: unknown): number | undefined {
    try {
        return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `utente_id` e `scuola_id` sono colonne `uuid`. Un valore che uuid non è farebbe fallire
 * l'INSERT con 22P02 — e 22P02 NON è un codice di schema mancante, quindi il breaker non si
 * aprirebbe e OGNI riga fallirebbe, per sempre, in silenzio. Si valida qui: un id malformato
 * costa il campo, non il log.
 */
function comeUuid(v: unknown): string | undefined {
    try {
        return typeof v === 'string' && UUID.test(v) ? v : undefined;
    } catch {
        return undefined;
    }
}
