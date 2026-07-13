import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUserId } from '@/lib/auth/require-staff';
import { appLogBatch, type RigaLog } from '@/lib/logging/app-log';
import { impostaUtente } from '@/lib/logging/context';
import { logEvento } from '@/lib/logging/logger';
import { redigiPathNelTesto } from '@/lib/logging/path';
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
    const rl = rateLimit(`logs:${clientIp(request)}`, { limit: LIMITE, windowMs: FINESTRA_MS });
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
    if (scartati > 0) {
        logEvento('logs', 'warn', {
            operazione: 'logs:POST',
            esito: 'eventi-scartati',
            n: scartati,
            ricevuti,
        });
    }

    // `scartati` SEMPRE nella risposta, anche a zero: è il campo su cui il client decide se il
    // batch è andato, ed è anche l'unico modo per accorgersene da fuori (con un curl, in CI).
    return NextResponse.json({ ok: true, ricevuti, scartati });
});
