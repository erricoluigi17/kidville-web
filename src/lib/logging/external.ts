import { logEvento, type Livello, type Valore } from './logger';
import { redigiPath } from './redact';
import { sanificaMessaggio } from './serialize';
import { conTetto, eTimeout, erroreTimeout, tettoNostro, tettoSano } from './tetto';

/**
 * Le chiamate ai provider ESTERNI (Resend, FCM, web-push, Aruba/SDI, SIDI).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * L'INVARIANTE, ed è la ragione per cui questo modulo esiste:
 *
 *   SU `!res.ok` IL CORPO DELLA RISPOSTA SI LEGGE, SI LOGGA E SI PROPAGA.
 *   MAI lo status da solo.
 *
 * Non è una buona pratica generica: è il guasto vero di questo progetto. Per MESI nessuna
 * email di credenziali è arrivata a un genitore, perché Resend rispondeva `403` e il codice
 * registrava soltanto il numero — mentre il corpo diceva, in chiaro, «the kidville.it domain
 * is not verified». `403` non dice nulla e nessun test era rosso; `403 "the domain is not
 * verified"` avrebbe chiuso il caso in cinque minuti. Lo stesso vizio è ancora in
 * `push/native-push.ts`, che il corpo FCM lo legge e poi lo butta (`fcm_http_${status}`).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * DOVE FINISCE IL CORPO, e perché NON in un campo `corpo`.
 *
 * Il corpo diventa il MESSAGGIO dell'errore che si passa a `logEvento`, non un campo dei
 * `campi`. `redact()` è a lista bianca PER CHIAVE e `corpo` in lista non c'è: nella riga che
 * va in `app_log` — l'unico canale che dura 30 giorni e si interroga in SQL — uscirebbe come
 * `[redatto:str/180]`, cioè illeggibile esattamente là dove serve. Passato invece come
 * errore, `descriviErrore()` lo normalizza nei campi dedicati: `message` → colonna
 * `app_log.messaggio` (in chiaro, e sanificato da `sanificaMessaggio`, che maschera email e
 * codici fiscali eventualmente presenti nel corpo del provider), `code` → colonna
 * `app_log.codice`, interrogabile. È la stessa scelta, con le stesse ragioni, di
 * `erroreDalCorpo()` in `supabase-fetch.ts`.
 *
 * IL SUCCESSO SI LOGGA (AGENTS, regola 5). Con i soli errori, «nessun log» non distingue
 * «tutto ok» da «non è mai partito niente» — ed è precisamente l'ambiguità che ha tenuto
 * nascosto per mesi il guasto delle email. Chi passa un `evento` fra quelli critici
 * (`email`, `push`, …: vedi `EVENTI_PERSISTITI`) ottiene il battito anche in tabella.
 *
 * Regola d'oro del modulo, come per tutto `src/lib/logging/**`: NON LANCIA MAI. Nemmeno su
 * rete giù, nemmeno su una risposta illeggibile. Un guasto dell'osservabilità non può
 * diventare un guasto del prodotto: si restituisce un esito che il chiamante può leggere.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * E DA QUI PASSA ANCHE LA RESILIENZA, non solo l'osservabilità (vedi `TETTO_MS_DEFAULT`).
 *
 * Il modulo è nato per GUARDARE le chiamate ai terzi, e per questo non si era mai occupato di
 * come finiscono. Ma è anche l'UNICA porta da cui passano tutti i provider — lo impone
 * `__tests__/architecture/provider-esterni-osservati.test.ts` — e un tetto di tempo messo qui
 * è un posto solo invece di tredici, valido anche per i chiamanti che non sanno di averne
 * bisogno. L'interruzione cade poi nel ramo `catch` che c'era già: un timeout smette di essere
 * un buco silenzioso e diventa una riga con un codice suo.
 *
 * ⚠️ IL MECCANISMO DEL TETTO NON STA PIÙ QUI: sta in `./tetto`, e lo condivide col gemello
 * `supabase-fetch.ts`. Quando è nato — la mattina del 2026-08-03 — era scritto solo dentro
 * questo file, e la strada accanto è rimasta scoperta per mezza giornata **col gate verde**.
 * Qui restano i NUMERI (quanto aspetta ogni provider, e perché), che sono l'unica cosa che di
 * questo modulo è davvero.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Quanto corpo d'errore ci si porta dietro (nell'esito e nel log). */
const CORPO_MAX = 1_000;

/**
 * IL TETTO DI TEMPO, in millisecondi, su una chiamata a un provider esterno.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE, MISURATO E NON DEDOTTO. `fetch` non ha nessun timeout di suo. Un server
 * locale che ACCETTA la connessione e non risponde mai, chiamato con la stessa primitiva di
 * questo modulo, è rimasto appeso **150 secondi senza eccezione né timeout** — e sarebbe
 * rimasto appeso finché la piattaforma non taglia la funzione. Fino al 2026-08-03 nessuno dei
 * 13 chiamanti passava un `signal`: `AbortSignal` compariva in `src/` due volte sole, ed
 * erano entrambe nella sonda della pagina offline.
 *
 * Cosa costa, e a chi. L'operatore che ha premuto «invia» aspetta senza limite e senza
 * errore; la lambda resta occupata. Il caso peggiore è la validazione di un embed Instagram,
 * che è SINCRONA dentro la richiesta: l'utente guarda una rotella che non finisce.
 *
 * UN TIMEOUT NON È UNA RETE GIÙ, e per questo ha un codice suo (vedi `erroreTimeout` in
 * `./tetto`): «il provider non risponde» si ripara alzando il tetto o chiamando il fornitore,
 * «il provider non si raggiunge» si ripara sul DNS o sul firewall.
 *
 * IL TAGLIO DI PIATTAFORMA RESTA IL LIMITE ESTERNO: un tetto per provider più alto di quello
 * non scatta mai. Serve quindi che i valori qui sotto ci stiano DENTRO con margine — ed è un
 * vincolo ANCORATO, non un proposito: `logging-external.test.ts` pretende che nessun provider
 * superi i 30 secondi. Senza quell'ancoraggio i test pinnavano solo l'ORDINE relativo, e
 * moltiplicando ogni valore per 60 la suite restava verde mentre in produzione il difetto
 * tornava intero.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
const TETTO_MS_DEFAULT = 10_000;

/**
 * I provider per cui il default non è il numero giusto. Volutamente corta: un tetto per
 * provider è una deroga, e ognuna qui dentro deve dire perché.
 *
 * `instagram` — è l'unica chiamata a un terzo fatta DENTRO la richiesta di un operatore che
 * sta aspettando (la validazione dell'embed), e il suo esito è best-effort: un health-check
 * che non risponde in quattro secondi ha già risposto. Si stringe QUI e non nella route
 * perché il tetto per provider è precisamente ciò che permette di coprire un chiamante senza
 * toccarne il file.
 *
 * `aruba` — upload del tracciato FatturaPA e polling SDI: il lavoro dall'altra parte è più
 * grosso di una POST di due righe, e la risposta di `getByFilename` può portarsi dietro il PDF
 * della fattura in base64. Con il default si trasformerebbe una consegna lenta ma riuscita in
 * un fallimento fiscale.
 */
export const TETTI_MS_PROVIDER: ReadonlyMap<string, number> = new Map<string, number>([
    ['instagram', 4_000],
    ['aruba', 30_000],
]);

/**
 * IL MASSIMO ASSOLUTO che un CHIAMANTE può chiedere con `timeoutMs`, in millisecondi.
 *
 * Il taglio di piattaforma è il limite esterno: un tetto più alto non scatta mai, quindi
 * chiederne uno di mezz'ora equivale a non averne — il difetto di partenza, rientrato dalla
 * porta che esiste per tenerlo fuori. Fino al 2026-08-03 questo limite valeva solo per la
 * TABELLA qui sopra (e solo nei test): `tettoMs('resend', 3_600_000)` restituiva 3.600.000.
 *
 * 30 secondi e non meno: è il valore di `aruba`, cioè la deroga più larga che questa tabella
 * concede, e un chiamante non deve poter chiedere più di quanto il provider più lento già
 * ottiene. Sotto quel numero si può sempre stringere — è a questo che la valvola serve.
 *
 * NON tosa il valore della tabella, di proposito: quello lo misura l'ancoraggio assoluto in
 * `__tests__/lib/logging-external.test.ts`, e un `Math.min` qui lo renderebbe verde per
 * costruzione. Vedi `tettoSano` in `./tetto`, dove la distinzione è scritta per intero.
 */
const TETTO_MS_MAX = 30_000;

/**
 * Quanto si aspetta questa chiamata: la richiesta del chiamante (mai oltre `TETTO_MS_MAX`),
 * poi il tetto del provider, poi il default. Non ha stato ed è esportata perché la tabella qui
 * sopra sia verificabile senza aspettare dieci secondi per volta
 * (`__tests__/lib/logging-external.test.ts`).
 *
 * Un valore assurdo (`0`, negativo, `NaN`, `Infinity`) NON diventa «nessun tetto»: `0` e i
 * negativi interromperebbero la chiamata prima di farla, `NaN` e `Infinity` danno un
 * `AbortSignal.timeout` che non scatta mai — cioè di nuovo il difetto. Si torna al tetto del
 * provider, che è il verso giusto in cui sbagliare.
 */
export function tettoMs(provider: string, richiesto?: number): number {
    try {
        return tettoSano(richiesto, TETTI_MS_PROVIDER.get(provider) ?? TETTO_MS_DEFAULT, TETTO_MS_MAX);
    } catch {
        return TETTO_MS_DEFAULT;
    }
}

/**
 * Tetto REALE, in byte, di quanto corpo si LEGGE dallo stream. Non è la stessa cosa di
 * `CORPO_MAX`: un `await res.text()` seguito da uno `.slice()` bufferizzerebbe comunque
 * TUTTA la risposta in RAM prima di poterla tagliare, e la pagina HTML che un proxy a monte
 * sputa al posto del provider non ha nessun obbligo di essere piccola. Si legge a pezzi e si
 * smette: il limite è quello scritto qui, non quello che dichiara chi risponde.
 */
const CORPO_LETTURA_MAX = 64_000;

export interface EsitoEsterno {
    ok: boolean;
    /** Lo status HTTP. `0` quando una risposta non c'è stata affatto (rete giù, DNS, TLS). */
    stato: number;
    /**
     * Il corpo dell'errore — o il messaggio dell'eccezione di rete. SEMPRE valorizzato quando
     * `ok` è falso (salvo che il provider abbia risposto davvero a corpo vuoto), SEMPRE vuoto
     * quando `ok` è vero: lì il corpo non lo tocchiamo (vedi `res`).
     */
    corpo: string;
    /**
     * La `Response`, SOLO quando `ok` è vero, e con il corpo INTATTO: lo stream si consuma una
     * volta sola, quindi chi chiama deve poter fare il suo `res.json()`. Su `!ok` non c'è, e
     * non è una dimenticanza: il corpo l'abbiamo già consumato noi per poterlo loggare, e
     * restituire una Response svuotata sarebbe una trappola.
     */
    res?: Response;
}

export interface OpzioniEsterne {
    /**
     * L'evento di dominio della riga. Default `esterno`.
     *
     * Serve a una cosa sola, ma è quella che rende il log utile: `email` e `push` sono in
     * `EVENTI_PERSISTITI`, quindi con il nome giusto anche il SUCCESSO finisce in tabella
     * (regola 5) e una sola query — `where evento = 'email'` — restituisce sia gli invii
     * riusciti sia quelli rifiutati. Con un `esterno` cablato qui dentro, il chiamante
     * dovrebbe emettere una SECONDA riga per il proprio evento: due righe per una chiamata,
     * su un canale dove «un logger loquace ACCECA» (vedi `logger.ts`).
     */
    evento?: string;
    /**
     * Metadati aggiuntivi. Attenzione ai NOMI: `redact()` è a lista bianca per chiave, quindi
     * in TABELLA sopravvivono in chiaro solo le chiavi note (`operazione`, `piattaforma`,
     * `canale`, `esito`, `provider`, `stato`…) più numeri, booleani, uuid e date. Una chiave
     * inventata finisce in `app_log` come `[redatto:str/N]`.
     */
    campi?: Record<string, Valore>;
    /**
     * La gravità di un `!ok`. Default: `error`.
     *
     * Esiste per un caso solo, ma senza questa valvola quel caso AVVELENA il canale degli
     * errori: un token FCM di un'app disinstallata risponde `404`/`UNREGISTERED`. Non è un
     * guasto, è la vita normale di una scuola — e a livello `error` emetterebbe un Error
     * nativo su console per ogni genitore che cancella l'app, inquinando il raggruppamento di
     * `get_runtime_errors` e la colonna `livello` di chi in SQL cerca «gli errori di oggi».
     * La riga resta (a `info`, e in tabella se l'evento è critico): si conta, non allarma.
     *
     * VALE ANCHE QUANDO LA RISPOSTA NON ARRIVA (rete giù, scadenza del tetto): lì il predicato
     * riceve `stato: 0` e il messaggio dell'eccezione, cioè esattamente ciò che il chiamante si
     * ritroverà nell'esito. Non è un dettaglio: `instagram` ha il tetto più stretto della
     * tabella ed è dichiarato best-effort proprio dai due chiamanti che passano `() => 'info'`.
     */
    gravita?: (stato: number, corpo: string) => Livello;
    /**
     * Il tetto di tempo di QUESTA chiamata, in millisecondi. Default: quello del provider,
     * altrimenti `TETTO_MS_DEFAULT` (vedi `tettoMs`).
     *
     * È la valvola ergonomica per «questa chiamata è diversa dalle altre dello stesso
     * provider». Chi ha bisogno di governare l'interruzione per davvero — annullarla a mano,
     * legarla alla vita della richiesta — passa il proprio `init.signal`, che vince su tutto.
     *
     * SERVE A STRINGERE. Si può anche allargare, ma non oltre `TETTO_MS_MAX`: una richiesta più
     * grande viene tosata lì, perché un tetto che la piattaforma taglia prima non è un tetto.
     */
    timeoutMs?: number;
}

/**
 * `fetch` verso un provider esterno, osservato. `provider` è il nome breve che finisce sulla
 * riga (`resend`, `fcm`, `aruba`): è in lista bianca, quindi si legge in chiaro anche in
 * tabella.
 */
export async function externalFetch(
    provider: string,
    url: string,
    init?: RequestInit,
    opzioni?: OpzioniEsterne,
): Promise<EsitoEsterno> {
    const t0 = Date.now();
    const tetto = tettoMs(provider, opzioni?.timeoutMs);

    let res: Response;
    try {
        // `globalThis.fetch` risolto alla CHIAMATA, non al caricamento del modulo: Next 16
        // patcha il fetch globale per il proprio caching, e non c'è garanzia che l'abbia già
        // fatto quando questo modulo viene importato.
        res = await globalThis.fetch(url, conTetto(url, init, tetto));
    } catch (err) {
        // Rete giù, DNS, TLS, timeout. NON si rilancia — è il contratto di questo modulo:
        // il chiamante (l'invio di un'email, una push) deve poter degradare, non morire.
        //
        // Un'interruzione per scadenza si RIETICHETTA prima di loggarla: il DOMException che
        // arriva da `AbortSignal.timeout` porta un messaggio in inglese e un `code` numerico
        // (`23`, il codice legacy di DOMException), che nella colonna `app_log.codice` —
        // quella su cui si interroga — sarebbe indistinguibile da uno status. Per tutto il
        // resto si passa l'errore ORIGINALE al logger: ha lo stack vero, che dice CHI stava
        // chiamando il provider.
        const ms = Date.now() - t0;
        // `nostro` per la stessa ragione di `supabase-fetch`: se il chiamante ha passato un suo
        // signal, `conTetto` non ha applicato `tetto` e scriverlo nel messaggio sarebbe una
        // diagnosi inventata. Vedi `tettoNostro`.
        const errore = eTimeout(err)
            ? erroreTimeout('ExternalTimeoutError', 'dal provider', tettoNostro(url, init) ? tetto : null, err, ms)
            : err;
        const corpo = messaggioDi(errore);
        // LA VALVOLA `gravita` VALE ANCHE QUI, e per un po' non è stato vero: questo ramo
        // passava `'error'` CABLATO. I due chiamanti Instagram dichiarano `gravita: () => 'info'`
        // perché l'health-check dell'embed è best-effort — e `instagram` ha il tetto PIÙ STRETTO
        // della tabella, cioè è il percorso che finisce in scadenza più spesso di tutti. Con la
        // valvola scavalcata, una chiamata che PRIMA del tetto non produceva nessuna riga
        // cominciava a produrre la più rumorosa che esista: un Error nativo su console per ogni
        // post lento, cioè l'avvelenamento di `get_runtime_errors` che `gravita` esiste per
        // impedire. Gli argomenti sono gli stessi che il chiamante si ritrova nell'esito
        // (`stato: 0`, il messaggio dell'eccezione), così il predicato vede ciò che vedrà lui.
        emetti(provider, url, ms, undefined, livelloDi(0, corpo, opzioni), opzioni, errore);
        return { ok: false, stato: 0, corpo };
    }

    const ms = Date.now() - t0;
    const stato = statoDi(res);

    const esito = esitoDi(res);

    if (esito !== 'ko') {
        // Il corpo NON si tocca: lo stream si consuma una volta sola e il `res.json()` è del
        // chiamante. Il battito di successo è questa riga.
        //
        // ⚠️ «NON SO» NON È «È ANDATA BENE» — la forma gemella dei rilievi R3·R7·R12·R16·R24.
        // Quando `res.ok` non si può interrogare (getter ostile, Response esotica) il modulo
        // si asteneva dall'inventare un guasto — giusto — ma emetteva comunque il BATTITO DI
        // SUCCESSO, cioè `info` su un evento critico: email, push, fattura. Dichiarare
        // riuscito ciò che non si è potuto verificare è esattamente il guasto storico di
        // questo repo (mesi di credenziali «inviate» mentre il provider rispondeva 403).
        // Il valore di ritorno NON cambia — non tocca al logger decidere se il chiamante
        // debba riprovare — ma la riga smette di dire di sì e dice quello che sa.
        const illeggibile = esito === 'illeggibile';
        emetti(
            provider,
            url,
            ms,
            stato,
            illeggibile ? 'warn' : 'info',
            illeggibile
                ? { ...opzioni, campi: { ...opzioni?.campi, esito: 'esito-illeggibile' } }
                : opzioni,
            undefined,
        );
        return { ok: true, stato, corpo: '', res };
    }

    const corpo = await leggiCorpo(res);
    emetti(provider, url, ms, stato, livelloDi(stato, corpo, opzioni), opzioni, erroreHttp(stato, corpo));
    return { ok: false, stato, corpo };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Emissione. Niente qui dentro può lanciare.
 * ──────────────────────────────────────────────────────────────────────────── */

function emetti(
    provider: string,
    url: string,
    ms: number,
    stato: number | undefined,
    livello: Livello,
    opzioni: OpzioniEsterne | undefined,
    err: unknown,
): void {
    try {
        logEvento(nomeEvento(opzioni), livello, campiDi(provider, url, ms, stato, opzioni), err);
    } catch {
        // `logEvento` è già fail-open per costruzione; questo try è la rete sotto la rete.
        // Si perde il log, non l'email.
    }
}

function nomeEvento(opzioni: OpzioniEsterne | undefined): string {
    const e = opzioni?.evento;
    return typeof e === 'string' && e !== '' ? e : 'esterno';
}

/**
 * I campi della riga. L'ordine è il budget (Vercel taglia dalla CODA): prima `operazione`,
 * che è ciò che dice DI COSA si parla, poi i fatti della risposta.
 *
 * `provider`, `ms` e `stato` sono nostri e vincono su quelli del chiamante: sono la verità
 * misurata sulla risposta, non un'opinione. `stato` si OMETTE quando la risposta non c'è
 * stata: `stato: 0` finirebbe nella colonna `app_log.stato_http`, dove `where stato_http >=
 * 500` conta i guasti — e uno zero lì dentro è uno status HTTP che non esiste.
 */
function campiDi(
    provider: string,
    url: string,
    ms: number,
    stato: number | undefined,
    opzioni: OpzioniEsterne | undefined,
): Record<string, Valore> {
    try {
        return {
            operazione: operazioneDi(url),
            ...opzioni?.campi,
            provider,
            ms,
            stato,
        };
    } catch {
        // Uno spread su un Proxy ostile: si perdono i campi del chiamante, non la riga.
        return { provider, ms, stato };
    }
}

/**
 * Il nome di default dell'operazione: il PATTERN del path del provider. Non è cosmesi — è la
 * colonna `app_log.messaggio` di una riga di SUCCESSO: `testoEvento()` prende il primo fra
 * `msg`, `esito`, `operazione`, `stato`, e senza `operazione` il messaggio di ogni email
 * riuscita sarebbe la stringa «200». Chi chiama può (e dovrebbe) passarne uno parlante
 * (`sendEmail`, `messages:send`): questo è il ripiego perché nessuno resti muto.
 *
 * `redigiPath` + `sanificaMessaggio` come in `supabase-fetch.ts`: `operazione` è in lista
 * bianca, quindi `redact()` la lascia in chiaro E non la sanifica: se un id o un indirizzo
 * finisse nel path del provider, quello sarebbe il canale su cui nessun altro sta guardando.
 */
function operazioneDi(url: string): string {
    try {
        return sanificaMessaggio(redigiPath(new URL(url).pathname));
    } catch {
        return '?';
    }
}

/**
 * Default `error`; il chiamante può declassare (vedi `gravita`). Un predicato che lancia non
 * decide. Chiamata da TUTTI e due i rami di fallimento — il rifiuto HTTP e la risposta che non
 * arriva — perché una valvola che copre un percorso solo non è una valvola: è una dimenticanza
 * che aspetta il traffico giusto.
 */
function livelloDi(stato: number, corpo: string, opzioni: OpzioniEsterne | undefined): Livello {
    try {
        return opzioni?.gravita?.(stato, corpo) ?? 'error';
    } catch {
        return 'error';
    }
}

/**
 * Il corpo del provider diventa un Error VERO, e non un oggetto `{ message, code }` nudo, per
 * una ragione in più rispetto alla normalizzazione (che darebbero entrambi): `new Error()`
 * cattura lo STACK QUI, cioè dentro la catena di chiamate che parte dalla route. È ciò che
 * dice QUALE dei nostri percorsi ha parlato col provider — informazione che un `403` non ha
 * mai avuto, e che nella colonna `app_log.stack` resta.
 *
 * Un NOME proprio perché `get_runtime_errors` di Vercel raggruppa per *error name*: gli errori
 * dei provider stanno nel loro secchio invece di mescolarsi ai bug veri del codice.
 *
 * `code` è lo status: finisce in `app_log.codice` e si interroga (`where codice = '403'`).
 * L'Error grezzo non arriva mai su console — `logEvento` ne emette una COPIA sanificata.
 */
function erroreHttp(stato: number, corpo: string): Error {
    const err = new Error(corpo === '' ? `HTTP ${stato}` : corpo);
    err.name = 'ExternalHttpError';
    Object.assign(err, { code: String(stato) });
    return err;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Il corpo.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Legge il corpo con un limite VERO, a pezzi (vedi `CORPO_LETTURA_MAX`).
 *
 * Niente `clone()`, a differenza del gemello in `supabase-fetch.ts`: là il corpo deve restare
 * leggibile per postgrest-js, qui la risposta d'errore è NOSTRA — non la restituiamo a nessuno
 * — e si può consumare direttamente. (È anche il motivo per cui non c'è il `tee` e la sua
 * trappola: il `cancel()` di un ramo clonato non si risolve mai finché l'altro ramo vive.)
 */
async function leggiCorpo(res: Response): Promise<string> {
    try {
        const flusso = res.body;
        // `body` è null su un 204, o su una `Response` costruita senza corpo: `text()` dà ''.
        // Truthiness e non `=== null`: a runtime può arrivare una Response finta (un mock, un
        // polyfill) che il corpo non ce l'ha proprio.
        if (!flusso) return tronca((await res.text()).trim());

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
            void lettore.cancel().catch(() => {});
        }

        // `new Response(bytes).text()` invece di `TextDecoder`: quest'ultimo non è garantito
        // sotto l'ambiente jsdom dei test, `Response` sì. Se il taglio è caduto a metà di una
        // sequenza multibyte mette il carattere di sostituzione — in un corpo troncato va bene.
        return tronca((await new Response(unisci(pezzi, letti)).text()).trim());
    } catch {
        // Un log che tace su ciò che ha perso è un log che mente: si dice che il corpo c'era
        // e non si è potuto leggere, invece di lasciare il campo vuoto come se non ci fosse.
        return '[corpo-illeggibile]';
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

function tronca(s: string): string {
    return s.length > CORPO_MAX ? s.slice(0, CORPO_MAX - 1) + '…' : s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Letture difensive: `fetch` può risolversi con qualunque cosa (un mock, un
 * polyfill), e qui dentro non lancia niente.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Il messaggio dell'eccezione di rete: è ciò che il chiamante propaga al proprio esito. */
function messaggioDi(err: unknown): string {
    try {
        const m = (err as { message?: unknown } | null | undefined)?.message;
        if (typeof m === 'string' && m !== '') return tronca(m);
        return tronca(String(err));
    } catch {
        return '[errore-illeggibile]';
    }
}

/**
 * Tre stati, non due: `ok`, `ko`, e «non l'ho potuto leggere».
 *
 * Il terzo esisteva già nei fatti — `res.ok` può lanciare — ma veniva fatto ricadere su `ok`
 * con la motivazione «non si inventa un guasto». Astenersi dall'inventare un guasto è giusto;
 * il difetto era la conseguenza: la richiesta usciva col BATTITO DI SUCCESSO di un evento
 * critico. È la stessa forma che in `withRoute` ha prodotto 73 righe `KV_OK` su altrettante
 * richieste finite in 500 (quinto collaudo, R3·R7·R12·R16·R24): «non so» e «è andata bene»
 * sotto lo stesso marker.
 *
 * Chi chiama continua a ricevere `ok: true` — cambiare quello significherebbe far riprovare
 * un invio che forse è riuscito, e non è una decisione del logger — ma la riga lo dice.
 */
function esitoDi(res: Response): 'ok' | 'ko' | 'illeggibile' {
    try {
        return res.ok === true ? 'ok' : 'ko';
    } catch {
        return 'illeggibile';
    }
}

function statoDi(res: Response): number {
    try {
        return typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
    } catch {
        return 0;
    }
}
