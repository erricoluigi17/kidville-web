import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUserId } from '@/lib/auth/require-staff';
import { appLogBatch, type RigaLog } from '@/lib/logging/app-log';
import { impostaUtente } from '@/lib/logging/context';
import { logEvento } from '@/lib/logging/logger';
import { redigiPathNelTesto } from '@/lib/logging/path';
import { redact } from '@/lib/logging/redact';
import { descriviErrore } from '@/lib/logging/serialize';
import { withRoute } from '@/lib/logging/with-route';
import { clientIp, rateLimit } from '@/lib/security/rate-limit';
import { parseData } from '@/lib/validation/http';

/**
 * INGESTION DEI LOG DEL CLIENT (browser + WebView nativa).
 *
 * È l'unica route del progetto che accetta di scrivere in `app_log` su richiesta di chiunque.
 * Va quindi trattata per quello che è: UNA PORTA OSTILE, aperta di proposito.
 *
 * ANONIMA PER NECESSITÀ. Il caso d'uso numero uno sono gli errori sulla PAGINA DI LOGIN — dove
 * per definizione l'utente non ha ancora un'identità. Un gate qui non proteggerebbe nulla e
 * cancellerebbe la ragione per cui la route esiste: se il login si rompe, oggi non lo sappiamo.
 *
 * LE DIFESE, in ordine di ingaggio (ognuna ferma ciò che la precedente lascia passare):
 *  1. RATE-LIMIT per ip, PRIMA di leggere il body: un abuso non deve nemmeno costarci il parse.
 *  2. CAP IN BYTE dal `content-length`, e poi sulla stringa VERA (un `content-length` si può
 *     omettere o falsificare: quello dichiarato serve a rifiutare a costo zero, quello letto è
 *     l'unico che dice la verità). `JSON.parse` di 4 MB è la spesa che si sta evitando.
 *  3. ZOD + batch massimo 20.
 *  4. LIVELLI: solo `warn` e `error`. Un client non può riempire la tabella di `info`.
 *  5. `sorgente` NON viene dal body: è cablata a `'client'`. `piattaforma` ed `evento` sono
 *     vincolati (enum / slug). Vedi `nomeEvento` per il motivo — non è pignoleria, è che
 *     `evento` è una COLONNA su cui si fanno le query di sorveglianza.
 *  6. I CAMPI STRUTTURATI (`contesto.campi`) hanno forma chiusa: chiave
 *     `^[a-z][a-z0-9_]{0,31}$`, valore solo stringa (≤64) / numero / booleano, 12 per evento, e
 *     sopra a tutto la redazione di `redact()`. Vedi `CHIAVE_CAMPO`: qui le chiavi arrivano dal
 *     mondo, e in `redact.ts` è la CHIAVE a decidere il trattamento del valore — lasciarla
 *     libera sarebbe lasciar scegliere al client la propria redazione.
 *     ⚠️ `campi_scartati` ESISTE DUE VOLTE E SONO DUE NUMERI DIVERSI, da non sommare leggendo in
 *     SQL: quello dentro `contesto.campi` di un evento è ciò che il BROWSER ha buttato prima di
 *     spedire (`client.ts`, `CAMPI_SCARTATI` — l'unico che può vedere una chiave in camelCase,
 *     perché quella qui non arriva mai); quello nella riga `logs:POST`/`warn` qui sotto è ciò che
 *     ha buttato QUESTA route. Il primo è per evento, il secondo per batch.
 *
 * UN ELEMENTO ROTTO NON AFFONDA IL BATCH. La validazione è EVENTO PER EVENTO (`safeParse`),
 * non sull'array intero, e la risposta dice quanti ne sono entrati e quanti no
 * (`{ ricevuti, scartati }`). Prima bastava un solo evento con `messaggio: ''` — e ci si arriva
 * davvero: un `Promise.reject(new Error())` produce esattamente quello — per far rifiutare
 * l'INTERO batch con un 400, e i fino a 19 log VERI che gli stavano accanto morivano lì: il
 * client aveva già svuotato la coda, e `sendBeacon` non riporta l'esito. È lo stesso principio
 * di `redact.ts` e del `perCampo` di `app-log.ts`: si perde il campo rotto, non tutta la riga.
 * Le difese che restano sul BATCH sono solo quelle che il batch non lo possono nemmeno leggere
 * (byte, JSON, cardinalità): lì non c'è nessun evento buono da salvare.
 * Lo stesso principio scende di un altro livello con i `campi` (punto 6): un CAMPO fuori forma si
 * perde da solo e non porta via l'evento — vedi `campiAmmessi`, dove è anche misurato perché la
 * forma «ovvia» con `z.record` avrebbe fatto il contrario.
 *
 * L'IDENTITÀ NON SI PRENDE DAL BODY, MAI. Un utente dichiarato da chi lo usa non è
 * un'identità: è un'etichetta. Si legge server-side con `getRequestUserId` (header `x-user-id`
 * o `?userId=` — `sendBeacon` non può mandare header, quindi in pratica il query param), si
 * valida come uuid e si deposita nel CONTESTO con `impostaUtente`: da lì `appLog` riempie
 * `utente_id` esattamente come per ogni altra riga del sistema. Nessun campo di correlazione
 * arriva dal chiamante.
 *
 * PERCHÉ NON `resolveIdentity` (la sessione vera, anti-spoof). Due motivi, entrambi decisivi:
 * costerebbe tre round-trip al DB per ATTRIBUIRE UNA RIGA DI LOG, su una route che accetta 30
 * richieste al minuto per ip; e sul percorso legacy emette un `logEvento('auth','warn',
 * {tipo:'header-fallback'})` — cioè OGNI batch di log del client scriverebbe in tabella una
 * riga di auth in più. Un endpoint di logging che amplifica i log è un endpoint rotto.
 * Il rischio residuo è che un client si auto-attribuisca le proprie righe a un altro utente:
 * sporca la propria riga, non quelle altrui, e non è più di quanto già consenta il modello di
 * identità legacy dell'app (`ALLOW_HEADER_IDENTITY`).
 */

/** Il tetto vero. `sendBeacon` non spedisce oltre 64 KB: un body più grande non è nostro. */
const BYTE_MAX = 64_000;
const BATCH_MAX = 20;

/**
 * 30 richieste al minuto per ip, cioè fino a 600 eventi: larghissimo per un client sano (che
 * accoda e spedisce a raffiche), stretto per chi volesse riempire la tabella. Il limite è
 * per-processo (il rate-limiter è in memoria): su Fluid Compute è una difesa approssimativa,
 * ed è accettata — la seconda rete è il cap del batch, la terza è la deduplica per impronta,
 * che schiaccia mille righe identiche in una sola con `occorrenze = 1000`.
 */
const LIMITE = 30;
const FINESTRA_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Il nome dell'evento: uno slug corto, minuscolo. NON è testo libero, e la ragione è precisa —
 * `evento` è la colonna su cui si interroga `app_log` («i cron stanno girando?» è
 * `where evento = 'cron'`). Senza vincoli, un client ostile potrebbe scrivere righe con
 * `evento = 'cron'` e far MENTIRE la query di sorveglianza. Il prefisso `client:` qui sotto
 * chiude comunque la questione — nessun evento del server comincia così — e questo pattern
 * aggiunge il resto: niente spazi, niente a capo (che in un formato a righe è una riga di log
 * falsa), niente cardinalità infinita.
 *
 * Uno slug e non un enum chiuso: le boundary React arriveranno con nomi propri, e non si vuole
 * che un log venga scartato con un 400 perché l'elenco non era stato aggiornato. Il vincolo
 * che conta — l'impossibilità di impersonare un evento del server — è il prefisso, non l'elenco.
 */
const EVENTO = /^[a-z][a-z0-9-]{0,29}$/;

/**
 * Il `digest` di Next: l'unico filo che lega un errore visto dal client al suo stack sul
 * server. Vincolato a un token: finisce nella colonna `codice`, che è IN CHIARO (non passa da
 * `redact`), quindi non può essere testo arbitrario dell'utente.
 */
const DIGEST = /^[\w.:-]{1,64}$/;

/**
 * I DATI STRUTTURATI DI UN EVENTO DEL CLIENT — `contesto.campi`, la colonna che era sempre `{}`.
 *
 * IL FATTO, misurato in produzione: ogni riga `sorgente='client'` di `app_log` ha `contesto = {}`
 * — 3.626 eventi al giorno — e sotto quel vuoto stanno 301 `fotocamera-errore` su iOS che dicono
 * CHE è andata male e non dicono PERCHÉ. Non era distrazione: il canale non aveva un campo.
 *
 * LA CHIAVE È VINCOLATA PER TRE MOTIVI CUMULATIVI, e nessuno è pignoleria:
 *  1. questa è UNA PORTA OSTILE (vedi la testata): le chiavi arrivano dal mondo, e in `redact.ts`
 *     il nome della chiave è ciò che DECIDE il trattamento del valore. Una chiave libera è un
 *     modo di scegliersi la redazione;
 *  2. la chiave diventa un ramo di JSONB che si interroga a mano (`contesto->'campi'->>'ms'`):
 *     uno spazio o un `-` andrebbero protetti in SQL, `_` no;
 *  3. comincia per lettera minuscola, quindi `__proto__` non è ammissibile — l'oggetto lo si
 *     costruisce da input, e quello è l'unico nome che assegnato FA qualcosa invece di essere un
 *     campo. (`JSON.parse` crea `__proto__` come proprietà propria: il pericolo è reale.)
 *
 * GLI STESSI NUMERI stanno in `client.ts` (`CAMPI_MAX`, `CAMPO_TESTO_MAX`) e devono restare
 * uguali: un cap più largo là produce campi che qui si scartano, cioè dati che il client crede
 * spediti e che in tabella non esistono.
 */
const CHIAVE_CAMPO = /^[a-z][a-z0-9_]{0,31}$/;
const CAMPI_MAX = 12;
const CAMPO_TESTO_MAX = 64;

/**
 * Il valore di un campo: le tre forme che una colonna `jsonb` porta senza sorprese. Niente
 * oggetti e niente array — questo canale trasporta MISURE, non strutture, e un oggetto annidato
 * è anche il modo in cui il testo libero si traveste da chiave (rilievo M15 di `redact.ts`).
 *
 * NB: `z.number()` in zod 4 rifiuta da sé `NaN` e `Infinity` (verificato, non dedotto): in JSON
 * diventerebbero `null`, cioè un buco con l'aspetto di una misura.
 */
const campoValore = z.union([z.string().max(CAMPO_TESTO_MAX), z.number(), z.boolean()]);

/**
 * IL CONTRATTO SI APPLICA CAMPO PER CAMPO, e la ragione è misurata.
 *
 * La forma ovvia — `z.record(z.string().regex(CHIAVE_CAMPO), campoValore)` dentro `eventoSchema`
 * — in zod 4 fa fallire l'INTERO record appena UNA chiave è fuori forma (`invalid_key`), e con
 * il record cade l'evento: un campo scritto male porterebbe via il messaggio e lo stack che gli
 * stavano accanto. È esattamente il difetto che questa route ha già corretto un livello più su,
 * quando ha smesso di validare l'array intero (vedi «UN ELEMENTO ROTTO NON AFFONDA IL BATCH»).
 * Qui è lo stesso principio un livello più in basso: si perde il CAMPO rotto, non l'evento.
 *
 * L'involucro resta in `eventoSchema` come `record` di `unknown` con `.catch(undefined)`: un
 * `campi: 'pippo'` — o un array — si perde da solo senza portarsi via l'evento.
 */
function campiAmmessi(grezzi: Record<string, unknown> | undefined): {
    campi?: Record<string, string | number | boolean>;
    scartati: number;
} {
    if (grezzi === undefined) return { scartati: 0 };
    // `Object.create(null)`: la chiave la sceglie il client, ed è la stessa rete che `redact.ts`
    // tende sul body grezzo. Contro `__proto__` arrivano prima altre due difese — `z.record` lo
    // perde da sé ricopiando per assegnazione (misurato), e `CHIAVE_CAMPO` comincia per lettera —
    // ma un oggetto costruito da input non si costruisce mai su un prototipo.
    const campi: Record<string, string | number | boolean> = Object.create(null);
    let tenuti = 0;
    let scartati = 0;
    for (const chiave of Object.keys(grezzi)) {
        if (tenuti >= CAMPI_MAX) {
            // Oltre il tetto non si guarda nemmeno: si contano, così lo scarto non è muto.
            scartati++;
            continue;
        }
        if (!CHIAVE_CAMPO.test(chiave)) {
            scartati++;
            continue;
        }
        const valore = campoValore.safeParse(grezzi[chiave]);
        if (!valore.success) {
            scartati++;
            continue;
        }
        /*
         * `redigiPathNelTesto` SUI VALORI, e non è la ripetizione di ciò che fa già il client:
         * è il buco che si chiude, misurato su `redact.ts` alla mano.
         *
         * Sotto una chiave in lista bianca (`operazione`, `stato`, `tipo`…) `FORMA_ENUMERATO`
         * ammette anche lo slash iniziale — serve, perché `instrumentation.ts` ci scrive i pattern
         * di rotta. Quindi un `{ operazione: '/m/<uuid>' }` ha la forma di un enumerato perfetto e
         * uscirebbe IN CHIARO: 39 caratteri senza spazi, cioè la capability che apre il modulo di
         * preiscrizione di un minore, dentro una colonna che vive 30 giorni e si interroga in SQL.
         * Il client riduce già da sé (`client.ts`, regola 4) — ma il client gira su una macchina
         * che non controlliamo, ed è la stessa ragione per cui `messaggio` qui sopra ripassa dalla
         * stessa funzione.
         *
         * La riduzione può ALLUNGARE di qualche carattere (`/1/2` → `/[n]/[n]`), e nel caso raro in
         * cui superasse il cap il valore non esce comunque: `redact` non lo riconosce più come
         * enumerato e lo maschera. Si perde la diagnosi, non il segreto — il verso giusto.
         */
        campi[chiave] = typeof valore.data === 'string'
            ? redigiPathNelTesto(valore.data)
            : valore.data;
        tenuti++;
    }
    return tenuti === 0 ? { scartati } : { campi, scartati };
}

const eventoSchema = z.object({
    livello: z.enum(['warn', 'error']),
    evento: z.string().regex(EVENTO),
    messaggio: z.string().min(1).max(1_000),
    stack: z.string().max(8_000).optional(),
    route: z.string().max(300).optional(),
    // `.int()` e un intervallo plausibile: `stato` finisce in una colonna `int`, e uno `stato`
    // di 10^12 la farebbe traboccare — cioè un INSERT fallito per ogni riga del batch.
    // `0` è ammesso e ha un significato preciso: la richiesta non è mai partita (rete giù).
    stato: z.number().int().min(0).max(599).optional(),
    digest: z.string().regex(DIGEST).optional(),
    /**
     * I dati strutturati: qui SOLO l'involucro (un oggetto), la forma dei singoli campi la decide
     * `campiAmmessi` — vedi lì il perché. `.catch(undefined)` è il resto della disciplina: un
     * `campi` che non è nemmeno un oggetto si perde da solo e non fa scartare l'evento.
     */
    campi: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/**
 * L'INVOLUCRO, e solo lui. Gli elementi restano `unknown` di proposito: qui si valida ciò che
 * riguarda il BATCH (che ci sia, che sia un array, che non sfondi il tetto) — cioè le sole cose
 * per cui rifiutare tutto è l'unica risposta possibile. La forma del singolo evento la decide
 * `eventoSchema`, evento per evento, più sotto: un elemento malformato è un elemento perso, non
 * un batch perso.
 */
const bodySchema = z.object({
    eventi: z.array(z.unknown()).min(1).max(BATCH_MAX),
    piattaforma: z.enum(['web', 'ios', 'android']).default('web'),
});

export const POST = withRoute('logs:POST', async (request: Request) => {
    const rl = await rateLimit(`logs:${clientIp(request)}`, { limit: LIMITE, windowMs: FINESTRA_MS });
    if (!rl.ok) {
        // 429 → `withRoute` lo persiste (è fra le ANOMALIE_4XX): un burst di 429 su una route
        // pubblica è il segnale di un abuso, e vive solo se lo si conta nel tempo.
        return NextResponse.json(
            { error: 'Troppe richieste' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
        );
    }

    const dichiarati = Number(request.headers.get('content-length') ?? 0);
    // `Number('')` è 0 e `Number('abc')` è NaN: entrambi cadono qui sotto senza rifiutare —
    // il cap che decide davvero è quello sulla stringa letta, subito dopo.
    if (Number.isFinite(dichiarati) && dichiarati > BYTE_MAX) {
        return NextResponse.json({ error: 'Payload troppo grande' }, { status: 413 });
    }

    let grezzo: string;
    try {
        grezzo = await request.text();
    } catch {
        return NextResponse.json({ error: 'Body illeggibile' }, { status: 400 });
    }
    if (grezzo.length > BYTE_MAX) {
        // Il `content-length` mancava o mentiva. Qui si sa la verità, e si rifiuta PRIMA di
        // spendere un `JSON.parse` su una stringa che può essere arbitrariamente grande.
        return NextResponse.json({ error: 'Payload troppo grande' }, { status: 413 });
    }

    let corpo: unknown;
    try {
        corpo = JSON.parse(grezzo);
    } catch {
        return NextResponse.json({ error: 'Body JSON malformato' }, { status: 400 });
    }

    // L'identità PRIMA della validazione: se il batch è malformato, la riga di esito che
    // `withRoute` emetterà (400 da utente autenticato → `warn`, in tabella: è un bug del NOSTRO
    // client) deve dire A CHI è successo. Depositata dopo, quella riga sarebbe anonima.
    const utenteId = getRequestUserId(request);
    if (utenteId !== null && UUID.test(utenteId)) impostaUtente({ userId: utenteId });

    const dati = parseData(bodySchema, corpo);
    if ('response' in dati) return dati.response;

    /*
     * SI ACCUMULA, NON SI SCRIVE DENTRO IL CICLO.
     *
     * Un `await appLog(...)` qui dentro erano fino a VENTI chiamate RPC sequenziali — venti
     * round-trip al DB — per una sola richiesta, su una route ANONIMA che accetta 30 richieste
     * al minuto per ip: 600 round-trip al minuto da un client solo, e il costo lo pagava il DB
     * di produzione. La RPC `app_log_registra` accetta un ARRAY da sempre: `appLogBatch` lo
     * passa intero in un colpo solo. Nessuna proprietà si perde per strada (breaker, guardia
     * anti-ricorsione, `after()`, fail-open): è lo stesso percorso di scrittura di `appLog`.
     */
    const righe: RigaLog[] = [];
    let scartati = 0;
    /** Campi persi per forma: uno scarto muto sarebbe un dato che nessuno sa di non avere. */
    let campiScartati = 0;

    for (const grezzoEvento of dati.data.eventi) {
        // `safeParse` PER EVENTO: è qui che un elemento rotto smette di poter uccidere i suoi
        // vicini. Non lancia mai, e ciò che non passa non entra — ma non porta via nient'altro.
        const parsed = eventoSchema.safeParse(grezzoEvento);
        if (!parsed.success) {
            scartati++;
            continue;
        }
        const e = parsed.data;

        /*
         * `descriviErrore` e non un `sanificaMessaggio` a mano, ed è il punto in cui questa
         * route smette di fidarsi del client.
         *
         * `RigaLog` non redige NULLA per conto proprio: il suo contratto dice che chi scrive ha
         * già sanificato. Qui il testo arriva da un browser, cioè dal mondo — e un messaggio del
         * client contiene benissimo l'email del genitore («Impossibile inviare a mario@…»), e lo
         * STACK contiene il messaggio (l'header di V8 È il messaggio: sanificare solo `messaggio`
         * sarebbe decorativo). Passandoli da `descriviErrore` ottengono lo stesso identico
         * trattamento degli errori del server: header sanificato, frame intatti, cap in
         * caratteri, email e codici fiscali mascherati. Un solo apparato di redazione, non due.
         *
         * `redigiPathNelTesto` PRIMA di `descriviErrore`, ed è la difesa in profondità che
         * mancava. `sanificaMessaggio` maschera email, codici fiscali e vincoli Postgres, ma NON
         * i path — e in questo repo il path è una CREDENZIALE: `/m/<token>` è la capability che
         * apre il modulo di preiscrizione di un minore, e viaggia come SEGMENTO di path, non
         * come query param. Il client lo riduce già da sé (`client.ts`, regola 4), ma il client
         * gira su una macchina che non controlliamo: un'app installata da mesi, o modificata,
         * continuerà a spedire path grezzi — e questa colonna vive 30 giorni e si interroga in
         * SQL. Si riduce PRIMA perché `sanificaMessaggio` tronca a 500 caratteri, e ciò che è
         * stato tagliato non lo redige più nessuno.
         */
        const d = descriviErrore({
            message: redigiPathNelTesto(e.messaggio),
            stack: e.stack,
            digest: e.digest,
        });

        const c = campiAmmessi(e.campi);
        campiScartati += c.scartati;

        righe.push({
            livello: e.livello,
            // `client:` — vedi `EVENTO`: rende impossibile impersonare un evento del server
            // (`cron`, `email`, `route`) e falsare le query di sorveglianza.
            evento: `client:${e.evento}`,
            sorgente: 'client',
            piattaforma: dati.data.piattaforma,
            messaggio: d.messaggio,
            stack: d.stack,
            // Il digest nella colonna `codice`: È il codice d'errore di un errore React in
            // produzione, ed è l'unica chiave che lo lega allo stack che Next ha tenuto per sé.
            // In `contesto` non ci potrebbe stare: `redact()` è a lista bianca per chiave, e
            // `digest` non è in lista — uscirebbe come `[redatto:str/10]`, cioè cancellato.
            codice: d.digest,
            statoHttp: e.stato,
            // La ROTTA DELLA PAGINA, l'unica cosa che il client sa e il server no: qui
            // `contesto().path` vale `/api/logs` per ogni riga — il nome del camion, non quello
            // del luogo dell'incidente. `appLog` la riduce comunque a pattern (`redigiPath`).
            route: e.route,
            /*
             * I DATI STRUTTURATI, sotto `campi` come per ogni riga del server (`logger.ts →
             * rigaEvento`): la stessa chiave da entrambi i lati, così
             * `contesto->'campi'->>'error_code'` è UNA query e non due.
             *
             * `redact()` E NON `redactInput()`, ed è la decisione da motivare per intero.
             * `redactInput` («la chiave non apre») esiste per il payload grezzo, e la sua doc dice
             * di non applicarlo ai `campi` — «quelli li scrive il nostro codice, e lì la lista
             * bianca è ciò che rende `app_log` interrogabile». Qui i campi li scrive il nostro
             * codice, ma su una macchina che non controlliamo: un'obiezione vera. Vale comunque
             * `redact`, per due ragioni misurabili:
             *   · con `redactInput` NESSUNA stringa uscirebbe leggibile (passano solo uuid, date,
             *     numeri e booleani), cioè `error_code: 'NotAllowedError'` — il PERCHÉ dei 301
             *     `fotocamera-errore`, la ragione per cui questo canale esiste — arriverebbe come
             *     `[redatto:str/16]`. Un canale che non dice niente non è una difesa: è il vuoto
             *     di prima con più righe di codice;
             *   · e quello che passa qui è STRETTAMENTE MENO di quanto già passa accanto:
             *     `messaggio` ammette 1.000 caratteri di testo quasi libero (`sanificaMessaggio`
             *     maschera email, codici fiscali e vincoli Postgres, non la prosa), mentre sotto i
             *     `campi` la lista bianca è di ~30 chiavi e IL VALORE DEVE CONFERMARE: niente
             *     spazi, niente a capo, 64 caratteri, e nemmeno la forma di un codice fiscale
             *     (`FORMA_ENUMERATO` + `FORMA_CODICE_FISCALE`). Chi volesse scrivere testo libero
             *     in tabella non passerebbe da qui: userebbe il messaggio, come poteva già ieri.
             * Chi un giorno volesse la versione severa cambia UNA chiamata, qui.
             *
             * ⚠️ A CHI LEGGERÀ `contesto->'campi'` IN SQL: su una riga DEDUPLICATA questi valori
             * sono il CAMPIONE DELLA PRIMA OCCORRENZA DEL GIORNO, non l'insieme e non l'ultima.
             * `campi` NON entra nell'impronta (`impronta` in `app-log.ts` non lo riceve, e non
             * deve: porta `ms` e contatori che cambiano a ogni occorrenza, e ci sono occorrenze a
             * migliaia — metterli nella chiave spegnerebbe la deduplica). Quindi una riga con
             * `occorrenze = 900` e `campi.ms = 1200` NON dice che sono stati 900 volte 1.200 ms:
             * dice che la prima volta di quel giorno furono 1.200 ms. È la stessa avvertenza che
             * vale per `request_id` e `scuola_id`, ed è scritta anche nella migrazione.
             */
            contestoExtra: c.campi === undefined ? undefined : { campi: redact(c.campi) },
        });
    }

    // UN SOLO round-trip per l'intero batch. `appLogBatch` non lancia e non rigetta mai: l'`await`
    // qui non è una rete di sicurezza, è solo il modo di non lasciare una promise orfana in una
    // lambda che sta per rispondere (dentro, `after()` la tiene comunque viva oltre la risposta).
    const ricevuti = righe.length;
    if (ricevuti > 0) await appLogBatch(righe);

    // Uno scarto è un BUG DEL NOSTRO CLIENT: ha spedito un evento che il nostro stesso schema
    // rifiuta. È lo stesso ragionamento per cui `withRoute` manda in tabella i 400 degli utenti
    // autenticati — e senza questa riga lo scarto sarebbe invisibile da entrambi i lati (il
    // client non guarda la risposta, il server non lo raccontava a nessuno). `warn`, quindi
    // persistito; deduplicato per impronta, quindi una riga al giorno anche se succede mille
    // volte. Un `catch` che non logga è un bug: anche quando il `catch` si chiama `safeParse`.
    //
    // Lo stesso vale un livello più in basso, per i CAMPI: un campo scartato per forma è un
    // nostro chiamante che ha usato una chiave che il nostro schema non ammette, e senza questa
    // riga non se ne accorgerebbe nessuno — in tabella un campo mancante è indistinguibile da un
    // campo mai passato. `esito` dice quale dei due scarti è avvenuto (gli eventi prima: sono la
    // perdita più grave); i due conteggi ci sono sempre entrambi.
    if (scartati > 0 || campiScartati > 0) {
        logEvento('logs', 'warn', {
            operazione: 'logs:POST',
            esito: scartati > 0 ? 'eventi-scartati' : 'campi-scartati',
            n: scartati,
            campi_scartati: campiScartati,
            ricevuti,
        });
    }

    // `scartati` SEMPRE nella risposta, anche a zero: è il campo su cui il client decide se il
    // batch è andato, ed è anche l'unico modo per accorgersene da fuori (con un curl, in CI).
    return NextResponse.json({ ok: true, ricevuti, scartati });
});
