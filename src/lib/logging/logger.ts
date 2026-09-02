import { contesto, inLogger, entraNelLogger, segnalaErroreLoggato } from './context';
import { descriviErrore, sanificaMessaggio, serializza, type ErroreDescritto } from './serialize';
import { redact, valoreDistintivo } from './redact';
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
 * IL NOME DELLA ROTTA HA UNA CHIAVE SOLA PER CANALE, e non è la stessa nei due canali:
 *
 *  - sulla RIGA (Vercel) è SEMPRE `rt=`, per tutti e tre i marker. Su Vercel la ricerca è
 *    full-text: se lo stesso nome uscisse come `rt=` sui successi, `op=` sugli errori e
 *    `operazione=` sugli eventi, non esisterebbe UNA query per "tutti i log della route X" —
 *    ne servirebbero tre, e chi indaga non saprebbe di doverle fare.
 *  - nella riga PERSISTITA è `operazione`, e non può essere `rt`: `redact()` è a lista bianca
 *    PER CHIAVE, `operazione` è in lista e `rt` no, quindi in tabella `rt` uscirebbe come
 *    `[redatto:str/24]` — cioè la riga non direbbe più QUALE route ha fallito, che è il dato
 *    più importante che ha.
 *
 * Perciò il CHIAMANTE passa sempre `operazione` (l'unico nome che sopravvive ai due canali) e
 * la traduzione in `rt` avviene qui, una volta sola, per tutti.
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

/**
 * I NOMI DI EVENTO AMMESSI — elenco CHIUSO.
 *
 * `evento` è il discriminante trasversale di `app_log`: è la colonna su cui si raggruppa per
 * chiedere «questa categoria di cose funziona?». Una colonna del genere regge solo se il
 * vocabolario è chiuso, e in questo repo non lo era: convivevano `galleria` (9 usi) e
 * `gallery` (1), `modulistica` (34) e `forms` (3), `pagamento` (39) e `pagamenti` (1).
 *
 * Non è pedanteria lessicale. Un sinonimo SPEZZA le query in silenzio — `where evento =
 * 'modulistica'` non conta i tre invii finiti sotto `forms`, e chi legge non ha modo di
 * sapere che gli manca qualcosa. E c'è un modo peggiore di sbagliare, che era già armato:
 * `EVENTI_PERSISTITI` contiene `pagamento` al SINGOLARE, quindi un
 * `logEvento('pagamenti', 'info', …)` di successo non sarebbe stato persistito affatto —
 * il fallimento silenzioso esatto per cui esiste tutto questo modulo.
 *
 * Il lock è `__tests__/architecture/eventi-log.test.ts`: nessun `logEvento('…')` del repo può
 * usare un nome fuori da qui, e `EVENTI_PERSISTITI` dev'essere un sottoinsieme di questo
 * elenco. Un nome nuovo si aggiunge QUI, deliberatamente — non lo si inventa al volo in una
 * route, che è come sono nati i tre sinonimi.
 *
 * NON copre gli eventi del CLIENT (`client:fetch`, `client:js`, …): li produce
 * `/api/logs`, che li prefissa `client:` proprio per rendere impossibile impersonare un
 * evento del server. Lì il vocabolario è aperto per progetto e il presidio è il prefisso.
 */
export const EVENTI_NOTI = new Set([
    // Dominio applicativo. `candidatura` è il modulo pubblico di `/lavora-con-noi`: NON è un
    // sinonimo di `iscrizione`, che è la domanda di iscrizione di un bambino — due percorsi
    // diversi, due tabelle diverse, e tenerli sulla stessa etichetta renderebbe illeggibile
    // proprio la query che serve («quante candidature sono arrivate?»).
    //
    // `personale` (2026-08-11) è il TERZO di quella famiglia, e vale lo stesso ragionamento:
    // è il modulo pubblico `/anagrafica-personale`, cioè l'anagrafica di chi il rapporto di
    // lavoro ce l'ha GIÀ. Non è `candidatura` (chi si propone, e di cui la Scuola non sa
    // ancora nulla) e non è `anagrafica`, che in questo repo indica le note tecniche
    // sull'identità di genitori e alunni: tre canali sulla stessa etichetta renderebbero
    // impossibile la sola query che conta, «quante anagrafiche del personale sono arrivate?».
    'agenda', 'anagrafica', 'audit', 'avvisi', 'candidatura', 'cassa', 'chat', 'competenze',
    'credenziali', 'diary', 'fascicolo', 'fattura', 'fea', 'fiscale', 'galleria', 'gdpr',
    'iscrizione', 'mensa', 'modulistica', 'multi_sede', 'news', 'notifica', 'otp', 'pagamento',
    'pagella', 'personale', 'protocolli', 'registro', 'segnalazione', 'sidi',
    // Infrastruttura. `db`/`rpc`/`storage`/`auth`/`altro` sono le aree di `supabase-fetch`,
    // `esterno` il default di `externalFetch`, `email`/`push` i suoi due chiamanti nominati,
    // `route` la riga di esito di `withRoute`, `app_log` il sink che si segnala da solo,
    // `logs` l'ingestione client, `sconosciuto` il ripiego di `componi()` e della RPC.
    'altro', 'app_log', 'auth', 'config', 'cron', 'db', 'email', 'esterno', 'logs', 'push',
    'route', 'rpc', 'sconosciuto', 'storage', 'traduzione', 'unhandled',
]);

/**
 * Eventi i cui SUCCESSI vengono persistiti (deroga a "solo warn+error in tabella").
 *
 * AGGIUNTI IL 2026-07-31 — `galleria`, `modulistica`, `multi_sede`. Il `sede_id` sugli eventi
 * di pubblicazione era un obiettivo dichiarato dell'audit multi-sede, ma quegli eventi sono a
 * livello `info`: senza allowlist non arrivavano in tabella, e in 30 giorni non c'era UNA riga
 * `galleria`. Alla domanda «in quale sede abbiamo pubblicato ieri?» `app_log` non sapeva
 * rispondere. Il volume è stato misurato prima di decidere (produzione, 30 giorni): 0 media in
 * galleria, 4 compilazioni di moduli, 10 avvisi — contro le 23,7 righe al giorno che la
 * tabella già assorbe. È rumore zero.
 *
 * `auth` NON è stato aggiunto, ed è la scelta che conta. I suoi `info` non sono segnali di
 * dominio: sono i rifiuti dei gate (`require-staff.ts` logga OGNI 401/403) e ogni risposta
 * non-ok di GoTrue vista da `supabase-fetch` (401 a sessione scaduta, 400 refresh token
 * invalido) — cioè le righe che il design §6 esclude esplicitamente, e per cui `route` non è
 * in allowlist. Gli `auth` che servono all'audit sono `warn`/`error` e si persistono già per
 * livello (19 righe misurate in produzione il giorno stesso): aggiungere `auth` avrebbe
 * portato zero del segnale voluto e tutto il rumore.
 *
 * AGGIUNTI IL 2026-08-01 — `avvisi` e `storage`. E qui prima c'era scritto il contrario, con
 * un numero a sostenerlo: «nel repo NON esiste nessun `logEvento('avvisi'…, 'info', …)`
 * (misurato: 0 su 522 chiamate) — metterli in allowlist sarebbe configurazione morta». La
 * misura era vera un'ora prima e falsa quando è stata scritta: il log di successo di
 * `avvisi:POST` e questo commento sono entrati nello STESSO commit (`534abd2`). Risultato
 * misurato in produzione il 2026-07-31: `select count(*) from app_log where evento='avvisi'
 * and livello='info'` → **0 da sempre**, con 10 avvisi pubblicati in 30 giorni, mentre il
 * campo `n_destinatari` — che esiste per scoprire che un avviso di classe ha raggiunto meno
 * famiglie di quante ce ne siano — non era interrogabile in SQL. Un commento che *giustifica*
 * un'esclusione con un fatto smesso di essere vero è peggio dell'esclusione: convince il
 * lettore successivo a non ricontrollare.
 *
 * `storage` entra per la ragione gemella. I bucket degli allegati (`avvisi_allegati`,
 * `task_allegati`) sono passati il 2026-07-31 da pubblici a privati con link firmato: «l'allegato
 * non si apre» è da allora un guasto NUOVO e plausibile. Senza una riga di successo del
 * caricamento, in tabella «nessun log di upload» non distingue «nessuno ha caricato niente» da
 * «gli upload non partono più» — che è, alla lettera, l'ambiguità con cui il guasto delle email
 * di credenziali è rimasto invisibile per mesi.
 *
 * ⚠️ `storage` È ANCHE UN'AREA DI `supabase-fetch` (`db`/`rpc`/`storage`/`auth`/`altro`), che
 * emette `info` ad alto volume: una risposta lenta, un 3xx. Che quelle righe non finissero in
 * tabella era garantito finora SOLO dal fatto che nessuna delle cinque aree fosse in questa
 * lista — una garanzia implicita, che questa riga avrebbe fatto saltare in silenzio. Ora è
 * esplicita e vive lì: `supabase-fetch` non persiste MAI i propri `info`, qualunque cosa dica
 * l'allowlist. Chi aggiunge qui `db`, `rpc`, `auth` o `altro` legga prima quel modulo.
 *
 * `registro` entra il 2026-08-07, e la sua deroga cade con la ragione che la reggeva. Diceva
 * «degradi di colonna sulle lezioni: il registro ha il suo dato in tabella, il log è
 * diagnostica» — vero finché su quel canale non passava nessun successo di dominio. Ora ci passa
 * l'assenza comunicata dal genitore, che è **una consegna**: la famiglia avvisa la scuola e i
 * docenti della sezione ricevono la notifica.
 *
 * Il punto non è la simmetria dell'elenco. La domanda che ha aperto quel lavoro era «il pulsante
 * dà errore e all'insegnante non arriva niente», e la risposta è stata trovata con una query:
 * *zero* notifiche `assenza_comunicata` emesse da sempre, su un difetto vissuto un mese senza
 * lasciare una riga. Senza questa voce, «sta funzionando adesso?» tornerebbe a essere
 * un'opinione: nei log di piattaforma la riga c'è, ma in `app_log` — l'unico posto
 * interrogabile — no. Gli `info` di questo canale sono **quattro** in tutto il repo: il volume
 * non è un argomento.
 *
 * ⚠️ `candidatura` NON È ANCORA QUI, e va aggiunto — ma nel commit che porta la route, non
 * prima. È stato messo in questa lista il 2026-08-10, quando `/lavora-con-noi` esisteva solo
 * come template dei campi, e il lock qui sotto è diventato rosso all'istante: «ogni evento di
 * `EVENTI_PERSISTITI` ha almeno un percorso di SUCCESSO che logga» non trovava nessun ramo
 * felice che lo emettesse. Un'allowlist che promette un battito inesistente è la stessa bugia
 * che questo lock esiste per impedire, e lasciarla lì significava tenere l'albero rosso per
 * tutti gli altri.
 *
 * La ragione per cui ci andrà resta intatta, e va letta prima di scrivere quella route: gli
 * `info` di questo canale sono **la sola prova che il modulo riceve candidature**. Non c'è una
 * schermata che si riempie a vista, non c'è una famiglia che telefona se non arriva niente: una
 * candidatura che non parte non se ne accorge nessuno. Senza quella riga, «nessun log»
 * significherebbe insieme «non si candida nessuno» e «il modulo è rotto» — l'ambiguità che ha
 * nascosto per mesi il guasto delle email di credenziali, quando il provider rispondeva 403 e
 * nessun test era rosso.
 *
 * Quindi: chi aggiunge `logEvento('candidatura', 'info', …)` nel ramo di successo del POST
 * aggiunge `'candidatura'` a questa lista NELLO STESSO COMMIT. Non è affidato alla memoria —
 * `__tests__/lib/insegnanti-template.test.ts` asserisce il BICONDIZIONALE (l'evento sta qui se
 * e solo se il battito esiste nel sorgente) e diventa rosso in entrambe le direzioni.
 *
 * Il lock è `__tests__/architecture/eventi-log.test.ts`: ogni `logEvento(evento,'info')` del
 * repo o è in questa lista, o sta fra le deroghe motivate. È l'unica cosa che impedisce al
 * difetto di tornare — perché quando torna, non si vede.
 */
export const EVENTI_PERSISTITI = new Set([
    'email', 'push', 'cron', 'fattura', 'pagamento', 'config', 'cassa', 'news', 'chat',
    'gdpr', 'segnalazione', 'galleria', 'modulistica', 'multi_sede', 'avvisi', 'storage',
    'registro',
    // `candidatura` entra ORA, con la route che porta il battito — non prima, che
    // era l'errore descritto nel blocco ⚠️ qui sopra. Il ramo felice di
    // `POST /api/iscrizione/insegnanti` emette `logEvento('candidatura','info',…)`
    // con `esito: 'candidatura-ricevuta'`: è la sola prova che il modulo pubblico
    // riceve candidature, perché nessuna schermata si riempie a vista e nessuno
    // telefona se non arriva niente. Il bicondizionale è sorvegliato da
    // `__tests__/lib/insegnanti-template.test.ts`, che diventa rosso in ENTRAMBE
    // le direzioni: evento promosso senza battito, e battito senza promozione.
    'candidatura',
    // `iscrizione` entra qui insieme alla ricevuta che parte alla famiglia, per
    // la stessa ragione di `candidatura` e con la stessa forma. Il modulo
    // pubblico d'iscrizione non ha una schermata che si riempie a vista, e una
    // famiglia che NON riceve la ricevuta non telefona per dirlo: se ne sta
    // zitta, esattamente come ha fatto per 381 domande. Senza persistenza,
    // «nessuna riga» significherebbe insieme «non si iscrive nessuno» e «la
    // ricevuta non parte più» — l'ambiguità che il logging di questo repo
    // esiste per rompere.
    //
    // Sono cinque righe per domanda al massimo, su due o tre domande al giorno
    // (misurato il 2026-08-15: 18 negli ultimi sette giorni): il volume non è
    // un argomento contro.
    'iscrizione',
    // `personale` entra con la route che porta il battito, per la stessa ragione e
    // con lo stesso rischio: il ramo felice di `POST /api/iscrizione/personale` emette
    // `logEvento('personale','info',…)` con `esito: 'pratica-ricevuta'`, ed è la sola
    // prova che il modulo `/anagrafica-personale` riceve qualcosa. Nessuna schermata si
    // riempie a vista, e una maestra che ha compilato non telefona per chiedere se è
    // arrivato: senza questa riga, «nessun log» significherebbe insieme «non ha
    // compilato nessuno» e «il modulo è rotto».
    //
    // ⚠️ NON si è usato `anagrafica`, che è già un evento noto e sarebbe stata la
    // scorciatoia: quel canale sta in `DEROGHE_INFO_NON_PERSISTITI`
    // (`__tests__/architecture/eventi-log.test.ts`) perché i suoi `info` sono note
    // tecniche di `ensureParentIdentity`. Riusarlo avrebbe voluto dire o un successo
    // che NON arriva in tabella — cioè il difetto misurato su `avvisi` il 2026-07-31 —
    // oppure promuovere di colpo 23 chiamate scritte per un altro scopo.
    'personale',
    // `credenziali` entra il 2026-09-01 con `POST /api/account/password`, che porta il
    // battito: il ramo felice emette `logEvento('credenziali','info',…)` con
    // `esito: 'password-cambiata'`.
    //
    // Fino a oggi questo canale aveva SOLO `warn` ed `error` (due chiamate in tutto il
    // repo: `admin/regenerate-credentials` e `admin/pratiche-personale`), cioè si
    // sapeva quando le credenziali NON si consegnavano e mai quando andavano a buon
    // fine. È la stessa asimmetria — «solo errori» — con cui il guasto delle email di
    // credenziali è rimasto invisibile per mesi, sullo stesso identico dominio.
    //
    // La domanda che senza questa riga resterebbe senza risposta è concreta e ha una
    // data: fra trenta giorni, «quante persone hanno scelto una password propria, e da
    // quale delle tre porte?». La tabella `password_cambi` tiene lo STATO (una riga per
    // account, aggiornata); `app_log` tiene il FATTO, con l'ora e l'esito — ed è
    // l'unico dei due che sa dire che un cambio è stato TENTATO e respinto. Con la sola
    // tabella, «nessuna riga nuova» non distingue «non cambia password nessuno» da
    // «l'instradamento al primo accesso non raggiunge più nessuno».
    //
    // Il volume non è un argomento: un cambio password è un gesto raro per definizione
    // (una volta per persona, in pratica), e il tetto di 5 tentativi ogni 15 minuti per
    // utente mette comunque un soffitto alle righe che una persona può produrre.
    //
    // ⚠️ Il bicondizionale è sorvegliato da `__tests__/architecture/eventi-log.test.ts`,
    // che diventa rosso in ENTRAMBE le direzioni: evento promosso senza battito, e
    // battito senza promozione. Le due modifiche vivono nello stesso commit.
    'credenziali',
]);

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
        // Chi chiama `logErrore` ha in mano l'errore VERO, con il suo stack: da qui in poi,
        // per questa richiesta, il guasto è registrato. `withRoute` legge questa marca e
        // rinuncia alla propria riga di esito sul 5xx, che sarebbe un doppione più povero.
        segnalaErroreLoggato();

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
            // `rt`, non `op`: una chiave sola per il nome della rotta su tutti e tre i marker
            // (vedi la doc in testa al modulo). In TABELLA la stessa cosa viaggia come
            // `operazione`, che è la chiave che sopravvive alla lista bianca di `redact`.
            rt: campi.operazione,
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
 *
 * `opzioni.persisti: false` — EMETTI MA NON PERSISTERE.
 *
 * Serve a un caso solo, ma è un caso che senza questa valvola fa danni: un errore il cui
 * bersaglio è IL CANALE DI PERSISTENZA STESSO. Se PostgREST risponde 503, o se l'host non si
 * raggiunge, la riga di log andrebbe scritta… su quello stesso database. Non ha senso scrivere
 * su un DB rotto per dire che il DB è rotto: la scrittura fallirà comunque, e nel frattempo si
 * aggiunge carico a un database che è già in affanno — proprio quando non può assorbirlo.
 *
 * Il livello resta `error`: la riga esce su Vercel (console), che è dove si guarda un DB giù.
 * Si rinuncia solo alla riga in tabella, che non si sarebbe potuta scrivere.
 *
 * Il default è invariato (si persiste secondo `vaPersistito`): la valvola va aperta a mano,
 * e chi la apre deve poter dire perché.
 */
export function logEvento(
    evento: string,
    livello: Livello,
    campi: Record<string, Valore>,
    err?: unknown,
    opzioni?: OpzioniEvento,
): void {
    try {
        const d = err !== undefined ? descriviErrore(err) : undefined;

        if (opzioni?.persisti !== false) {
            const riga = rigaEvento(evento, livello, campi, err, opzioni);
            if (riga) persisti(riga);
        }

        if (SILENZIOSO) return;

        const riga = unisci({ ...campiDelContesto(), evt: evento }, perLaRiga(campi));
        if (d) {
            // Assegnati DOPO l'unione: quando c'è un errore, è l'errore la verità, non i campi.
            // Sulla riga di console il `code` resta quello dell'ERRORE: `error_code` dei campi
            // è già stampato per conto suo, e stamparlo due volte con due nomi diversi
            // consumerebbe budget per dire la stessa cosa.
            const codice = d.codice ?? d.causa?.codice;
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

/**
 * Opzioni di `logEvento`.
 *
 * `distingui` — I CAMPI CHE DEVONO DISTINGUERE LA RIGA IN TABELLA.
 *
 * `app_log` deduplica per `(fingerprint, giorno)` e l'`ON CONFLICT` somma le occorrenze SENZA
 * aggiornare il `contesto`: la riga superstite conserva quello della PRIMA. E l'impronta si
 * compone dalle COLONNE, non dal contesto — per una ragione buona, scritta in `app-log.ts`: i
 * campi portano contatori che cambiano a ogni richiesta, e includerli ucciderebbe la deduplica.
 *
 * Conseguenza, misurata dal terzo collaudo: venti rifiuti su venti bambini altrui producevano
 * UNA riga, la cui colonna `contesto.campi.alunno_id` nominava il bambino della prima
 * occorrenza — mentendo su diciannove casi su venti; e due comunicazioni riuscite dello stesso
 * genitore lasciavano `alunno_id`, `presenza_id` e `n_docenti` della sola prima.
 *
 * `distingui: ['alunno_id']` fa entrare QUEL campo nell'impronta, e nient'altro. La decisione
 * sta nel chiamante perché è il chiamante a sapere se la riga descrive un'ENTITÀ (una
 * comunicazione, un rifiuto su un bambino) o un fatto aggregato (una tempesta di errori di
 * rete, dove sommare è esattamente ciò che si vuole).
 *
 * IL COSTO IN VOLUME VA DICHIARATO da chi la usa: una riga per (utente, bersaglio, giorno)
 * invece di una per (utente, giorno). Si usa dove il volume è limitato da un tetto di
 * frequenza o dalla natura del gesto — non sui canali ad alto volume.
 *
 * I valori passano da `valoreDistintivo`: uuid, numeri, booleani, date, enumerati. Un nome non
 * distingue, e non è una raccomandazione — è il codice a non farlo passare.
 */
export interface OpzioniEvento {
    persisti?: boolean;
    distingui?: readonly string[];
}

/**
 * Il BERSAGLIO della riga: `campo=valore` per ogni campo dichiarato, nell'ordine dichiarato.
 *
 * `undefined` quando non c'è niente di dichiarabile — e allora l'impronta resta quella di
 * sempre, cioè le righe già in tabella continuano a sommarsi con le nuove.
 */
function bersaglioDa(campi: Record<string, Valore>, distingui?: readonly string[]): string | undefined {
    try {
        if (!distingui || distingui.length === 0) return undefined;
        const parti: string[] = [];
        for (const nome of distingui) {
            if (!Object.hasOwn(campi, nome)) continue;
            const v = valoreDistintivo(campi[nome]);
            // FUORI FORMA NON SIGNIFICA «SALTA»: se il campo c'era e non è distinguibile, la
            // riga deve dirlo — altrimenti un valore ammesso e uno rifiutato finirebbero nella
            // stessa impronta senza che nessuno possa accorgersene. Il marcatore è costante:
            // due nomi diversi restano indistinguibili, che è il punto.
            parti.push(`${nome}=${v ?? '[fuori-forma]'}`);
        }
        return parti.length === 0 ? undefined : parti.join(';');
    } catch {
        return undefined;
    }
}

/**
 * IL CODICE DI UN RIFIUTO VA IN COLONNA, non solo dentro `campi` (rilievo T11).
 *
 * `app_log.codice` è popolata da `descriviErrore`, cioè solo quando c'è un ERRORE. Ma i rifiuti
 * 4xx non hanno un errore: hanno un codice deciso dal codice applicativo, che ventisette
 * chiamanti passano come `campi.error_code` — dove è in lista bianca di `redact` (mentre
 * `codice` non lo sarebbe). Risultato misurato: tre rifiuti con tre codici diversi collassavano
 * in UNA riga con `codice` NULL, e «quanti rifiuti per motivo troppo lungo?» non era una query.
 *
 * `codice` È nell'impronta: promuovendolo, i tre rifiuti diventano tre righe — ognuna con il
 * proprio contesto, quindi con il proprio `n` (la lunghezza del motivo, i giorni di distanza).
 *
 * L'errore VINCE: se c'è, il codice è quello di PostgREST, che descrive il guasto vero.
 */
function codiceDaCampi(campi: Record<string, Valore>): string | undefined {
    try {
        const v = campi.error_code;
        if (typeof v === 'string' && v !== '') return valoreDistintivo(v) ?? undefined;
        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * La riga destinata ad `app_log` per un evento di dominio.
 *
 * È estratta da `logEvento` — che la passa a `persisti` — perché è la parte DECIDIBILE del
 * logging: quale messaggio, quale codice, quale bersaglio. `persisti` è muta sotto vitest (il
 * bersaglio della suite non può essere il database di produzione), quindi senza questa
 * funzione le decisioni qui dentro non sarebbero misurabili da nessun test.
 */
export function rigaEvento(
    evento: string,
    livello: Livello,
    campi: Record<string, Valore>,
    err?: unknown,
    opzioni?: OpzioniEvento,
): RigaLog | undefined {
    try {
        const d = err !== undefined ? descriviErrore(err) : undefined;
        const c = contesto();
        return {
            livello,
            evento,
            messaggio: d ? d.messaggio : testoEvento(evento, campi),
            stack: d?.stack,
            codice: d?.codice ?? d?.causa?.codice ?? codiceDaCampi(campi),
            // Lo status HTTP va in COLONNA, non solo dentro `campi`: è il primo filtro di
            // qualunque query ("dammi i 5xx di ieri"), e sepolto in un JSONB non è né ovvio
            // né indicizzabile. Solo se `stato` è un NUMERO: negli eventi di dominio la stessa
            // chiave vale anche 'inviata', 'scaduto' — quello non è uno status HTTP.
            statoHttp: numeroDi(campi, 'stato'),
            sorgente: 'server',
            bersaglio: bersaglioDa(campi, opzioni?.distingui),
            contestoExtra: {
                campi: redact(campi),
                dettagli: d?.dettagli,
                suggerimento: d?.suggerimento,
                causa: d?.causa,
                payload: c?.payload, // già redatto: vedi logErrore
            },
        };
    } catch {
        // Fail-open: un guasto nella composizione non deve rompere il chiamante.
        return undefined;
    }
}

/**
 * Il nome della rotta sulla riga è `rt`, in tabella è `operazione` (vedi la doc in testa al
 * modulo). Il chiamante ne passa UNO, `operazione`; la riga lo rinomina, nella stessa
 * posizione (l'ordine dei campi è il budget: chi viene dopo è chi il taglio mangia per primo).
 *
 * Non lancia: al peggio restituisce i campi originali, e sulla riga si legge `operazione=`
 * invece di `rt=`. Un log meno comodo, non un log perso.
 */
function perLaRiga(campi: Record<string, Valore>): Record<string, Valore> {
    try {
        if (!Object.hasOwn(campi, 'operazione')) return campi;
        const out: Record<string, Valore> = {};
        for (const k of Object.keys(campi)) {
            if (k === 'operazione') out.rt = campi.operazione;
            else out[k] = campi[k];
        }
        return out;
    } catch {
        return campi;
    }
}

/** Legge un campo NUMERICO dei campi del chiamante, senza fidarsi né del tipo né dei getter. */
function numeroDi(campi: Record<string, Valore>, chiave: string): number | undefined {
    try {
        const v = campi[chiave];
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Messaggio della riga persistita quando l'evento non porta un errore: il campo più parlante
 * che c'è.
 *
 * `operazione` sta PRIMA di `stato` e non è un dettaglio: senza, la riga di un 5xx emessa da
 * `withRoute` (campi: operazione, stato, ms) avrebbe come `messaggio` la stringa "500" — la
 * colonna che un umano legge per prima, e su cui si fanno le query, direbbe "cinquecento" su
 * 239 route. Il nome della rotta è il minimo sindacale per capire di cosa si parla.
 *
 * `tipo` è entrato nella lista il 2026-07-31, e non per completezza: senza, i 18 log
 * dell'audit multi-sede — che passano `tipo:` e non `esito:` — scrivevano in `messaggio` il
 * nome NUDO dell'evento (`auth`, `multi_sede`, `mensa`, `agenda`). Misurato in produzione:
 * DICIASSETTE righe `messaggio = "auth"` che raccontavano cinque fatti diversi.
 *
 * E il danno non era solo estetico. `messaggio` ENTRA NELL'IMPRONTA (`impronta()` in
 * `app-log.ts`), il `contesto` no: con lo stesso messaggio, due segnali diversi sulla stessa
 * route+utente+giorno cadevano nella stessa chiave `(fingerprint, giorno)` e l'`ON CONFLICT`
 * li sommava in UNA riga — che conserva il `contesto` della PRIMA. Del secondo evento non
 * restava traccia, e la riga superstite attribuiva l'accaduto alla causa sbagliata. Una
 * colonna che mente è peggio di una colonna che manca: sulla prima ci si crede.
 *
 * PERCHÉ QUI E NON NELL'IMPRONTA. La tentazione era aggiungere il contesto a `impronta()`.
 * Sarebbe stato il rimedio sbagliato: i campi di questi eventi portano CONTATORI che cambiano
 * a ogni richiesta (`accessibili`, `selezionate`, `n`, `ms`), quindi ogni occorrenza avrebbe
 * prodotto una riga nuova — cioè la fine della deduplica, che esiste proprio per non farsi
 * sommergere. Mettere solo `tipo` nell'impronta, invece, avrebbe creato una seconda sorgente
 * di verità che prima o poi diverge da `messaggio`. Correggendo il messaggio si sistemano
 * entrambe le cose in un punto solo, e retroattivamente.
 *
 * L'ORDINE È DELIBERATO: `tipo` viene DOPO `operazione`, non prima. Nei chiamanti che passano
 * entrambi, `tipo` non è la categoria del segnale ma un dato di dominio — `agenda:POST` passa
 * `tipo: body.tipo` ('uscita', 'riunione') — e farlo vincere sostituirebbe il nome della rotta
 * con il contenuto di un body. Chi ha un `esito` o una `operazione` non cambia comportamento.
 */
function testoEvento(evento: string, campi: Record<string, Valore>): string {
    try {
        const v = [campi.msg, campi.esito, campi.operazione, campi.tipo, campi.stato].find(pieno);
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
