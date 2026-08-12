import { logClient, nomeErrore } from '@/lib/logging/client';
import { conTetto, eTimeout } from '@/lib/logging/tetto';
import { limiteUploadByte, limiteUploadMb } from '@/lib/upload/limite-piattaforma';

/**
 * CARICARE UN FILE VERSO UNA NOSTRA ROUTE — la logica, una volta sola.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE, detto senza abbellirlo. Questo codice viveva dentro `FileField`
 * (`FieldRenderer.tsx`), cioè dentro un componente, ed era raggiungibile solo rendendo
 * quel componente: per misurare il ramo del 413 bisognava montare una `<label>`, un
 * `<input>` e `useTranslations`. Estrarlo rende misurabili da soli dei rami che sono
 * già stati pagati in produzione — ed è tutto quello che l'estrazione ha comprato.
 *
 * ⚠️ CHI CHIAMA — due, e il conto va tenuto aggiornato perché qui è già stato sbagliato
 * DUE VOLTE in senso opposto. Prima la testata annunciava al futuro «il tab Documento sta
 * per avere DUE controlli di caricamento»; poi quella frase è stata cancellata come
 * «falsa» e sostituita con «`caricaFile` ha **un solo chiamante**», che *prescriveva*
 * `grep -rn caricaFile src` come prova — e quel comando, eseguito, ne restituisce due.
 * Oggi, misurato:
 *
 *   · `FieldRenderer.tsx` (`FileField`) — le porte ANONIME: i due wizard pubblici e i
 *     moduli delle famiglie. Il fronte/retro della carta d'identità sono due ISTANZE di
 *     questo stesso componente su due campi `type: 'file'` del template
 *     (`DocumentoIdentitaFields.tsx`), non due copie della logica;
 *   · `StaffDetailPanel.tsx` — il tab «Documento» della scheda staff, cioè la prima porta
 *     AUTENTICATA. È la ragione per cui esiste `headers` qui sotto: senza, quel pannello
 *     avrebbe dovuto riscriversi il `fetch` a mano, e con lui i cinque rami di questa
 *     testata.
 *
 * La lezione, visto che è costata due giri: **un commento che afferma un CONTEGGIO e
 * indica il comando per verificarlo scade il giorno in cui qualcuno chiama la funzione.**
 * Chi legge esegua il `grep`; chi aggiunge un chiamante aggiorni questo elenco. In un repo
 * la cui regola scritta è che «un documento che descrive una protezione che non c'è è
 * peggio di nessun documento», una testata smentita dalla propria prova è lo stesso
 * difetto in piccolo.
 *
 * I rami restano quelli, e sono validi per la ragione VERA: sono guasti già capitati.
 *
 *  1. LA TAGLIA SI CONTROLLA PRIMA DI SPEDIRE. Sopra il tetto della piattaforma la
 *     richiesta non arriva MAI alla nostra route: Vercel risponde 413
 *     `FUNCTION_PAYLOAD_TOO_LARGE` da sé, quindi nessun controllo lato server può
 *     scattare e nessun messaggio nostro può uscire. Il 31/07/2026 sono stati 41
 *     tentativi falliti in un giorno sul solo modulo pubblico. Vedi `limite-piattaforma`.
 *
 *  2. `res.ok` SI GUARDA PRIMA DI `res.json()`. Il corpo di quel 413 è
 *     `content-type: text/plain`: il parse LANCIA `SyntaxError`, e chi caricava leggeva
 *     «Caricamento non riuscito. Riprova.» — l'invito a rifare l'unica cosa che non
 *     poteva funzionare. In `app_log` restava `SyntaxError`, che del 413 non dice nulla.
 *
 *  3. IL `path` TORNA DAL CORPO, e una risposta senza `path` è un ERRORE: `res.ok` è
 *     vero, il caricamento «riesce», e il modulo resta col campo vuoto e nessuna
 *     spiegazione. Ha un messaggio TUTTO SUO in `app_log` (`modulo-allegato-senza-path`)
 *     e non è un vezzo: `nomeErrore` restituisce SOLO `e.name`, quindi finché questo ramo
 *     lanciava un `new Error('risposta senza path')` per cadere nel `catch`, in tabella
 *     arrivava `…-upload-fallito: Error` — indistinguibile da qualunque altro guasto, con
 *     la frase viva solo dentro `stack`, campo opzionale e troncato.
 *
 *  4. L'ERRORE NON PERDE LO STATO HTTP. `403` (sessione scaduta) e «rete assente» non
 *     sono lo stesso guasto, e chi rende deve poterli distinguere: `stato: null` dice
 *     «non c'è stata nessuna risposta», non «zero».
 *
 *  5. C'È UN TETTO DI TEMPO, e senza di lui i quattro punti qui sopra non arrivano mai a
 *     servire. Vedi `TETTO_UPLOAD_MS` qui sotto.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ DUE COSE RESTANO NEL COMPONENTE, E NON SONO DETTAGLI ESTETICI — sono RESA, non
 * logica, e chi toccasse `FileField` le deve conservare:
 *
 *  · LA GUARDIA CONTRO IL DOPPIO INVIO STA SULL'`onChange`, NON SU `disabled`. Il
 *    controllo NON si disabilita mentre il caricamento è in volo: disabilitare un
 *    elemento che ha il fuoco lo fa cadere su `<body>`, e colpirebbe esattamente chi ha
 *    appena scelto il file da TASTIERA. Si scrive `if (uploading) return` in cima al
 *    gestore, e che stia lavorando lo dicono il testo, la rotellina e `aria-busy`.
 *  · L'`<input type="file">` È `sr-only`, MAI `hidden`. Con `display:none` non è
 *    focalizzabile, non entra nel Tab e NON ESISTE nell'albero di accessibilità: la
 *    `<label>` che lo avvolge sembra un bottone e non lo è, e il campo diventa
 *    irraggiungibile senza mouse. `jest-axe` non lo vede (dava 0 violazioni).
 *
 * E UNA COSA CHE QUI NON ENTRA MAI: le stringhe mostrate all'utente. Sono di chi rende,
 * che ha il suo `useTranslations` e il suo tono. Questo modulo restituisce un ESITO, e non
 * traduce niente.
 *
 * Attraversano il confine DUE campi, e sono due perché uno solo non bastava:
 *  · `messaggioServer` — il campo `error` che la route ha scritto («Tipo di file non
 *    ammesso»). Non è nostro ed è ITALIANO PER COSTRUZIONE: nasce sul server, dove il
 *    locale dell'interfaccia non esiste;
 *  · `codice` — l'identificatore che la stessa route mette accanto alla prosa
 *    (`ALLEGATO_PDF_O_IMMAGINE`, `TROPPE_RICHIESTE`, …), l'unica cosa che rende quella
 *    frase traducibile. Chi rende lo passa a `messaggioDaCorpo`; buttarlo via e mostrare
 *    la sola prosa è il fallimento F2 del collaudo del 31/07/2026, e c'è già ricaduto un
 *    chiamante. Vedi la doc di `EsitoCaricamento.codice` qui sotto.
 *
 * ⚠️ FINO AL 13/08/2026 QUESTA RIGA DICEVA «l'unica stringa che attraversa il confine è
 * `messaggioServer`», mentre sessanta righe più in basso il tipo dichiarava già anche
 * `codice`: il file affermava e negava lo stesso fatto, e chi lo legge dall'alto — cioè
 * come è scritto per essere letto — usciva con l'informazione vecchia.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/**
 * QUANTO SI ASPETTA UN CARICAMENTO PRIMA DI DICHIARARLO PERSO.
 *
 * ─── PERCHÉ C'È ──────────────────────────────────────────────────────────────
 * `fetch` non ha nessun timeout di suo: è MISURATO in questo repo (testata di
 * `@/lib/logging/tetto`), un bersaglio che accetta la connessione e tace tiene appesa la
 * chiamata 150 secondi senza sollevare niente. Qui il conto lo paga l'interfaccia:
 * `FileField` mette `uploading = true` e lo rimette a `false` SOLO nel `finally`, mentre
 * `handleFile` comincia con `if (uploading) return`. Una richiesta che non si risolve mai
 * — rete mobile in zona morta, captive portal di un hotspot che inghiotte i POST — lascia
 * la rotellina che gira per sempre: nessun errore, nessun ritentativo, nessuna via
 * d'uscita che non sia ricaricare la pagina (e nel wizard dell'anagrafica, ricaricare
 * significa ricominciare). È il contrario esatto del difetto che questo modulo ripara.
 *
 * Il meccanismo non è scritto qui: si prende da `conTetto`, la primitiva condivisa —
 * `AbortSignal.timeout` è raggiunto in UN SOLO file di tutto `src/`, e il lock
 * `__tests__/lib/logging-tetto.test.ts` lo impone.
 *
 * ─── PERCHÉ 30 SECONDI, E COSA QUESTO NUMERO **NON** COPRE ───────────────────
 * 30 s è il massimo che il repo ammette per un tetto (`MAI_OLTRE_MS` nel lock): oltre,
 * un tetto è funzionalmente nessun tetto. Il costo va detto, perché è reale e non
 * teorico: il tetto vale per l'INTERA chiamata, compreso il tempo di spedire il corpo. Un
 * file al massimo consentito (4 MB, vedi `limite-piattaforma`) su un uplink da 1 Mbps
 * impiega ~32 s solo a partire, e verrebbe interrotto MENTRE stava funzionando.
 *
 * Si accetta, e non alla cieca: un'interruzione produce un errore visibile e un pulsante
 * che si può premere di nuovo, l'attesa infinita non produce niente. E la taratura non
 * resta un'opinione — la scadenza ha un messaggio suo, col NUMERO dentro
 * (`modulo-allegato-upload-scaduto: 30000 ms`), quindi se questo tetto è troppo stretto
 * lo dice `app_log` contandolo, invece di lasciarlo scoprire a chi carica.
 */
const TETTO_UPLOAD_MS = 30_000;

/**
 * I CAMPI DEL MULTIPART CHE APPARTENGONO A QUESTO MODULO, e che `extra` non può toccare.
 *
 * `FormData.get()` restituisce il PRIMO valore accodato, e `extra` veniva accodato PRIMA
 * di `max_size_mb`: un chiamante con `extra: { max_size_mb: '99' }` faceva leggere 99 alla
 * route mentre il client aveva appena applicato il tetto vero del campo. Il controllo
 * client e quello server divergevano SENZA CHE NIENTE LO SEGNALASSE — e la divergenza
 * silenziosa è il difetto, non il valore sbagliato.
 *
 * Si rifiuta invece di accodare `extra` per ultimo: accodarlo dopo farebbe vincere i
 * nostri campi con `get()`, ma lascerebbe sulla rete DUE valori per lo stesso nome, e il
 * tetto dipenderebbe da come la route legge (`get` o `getAll`) — cioè lo stesso difetto,
 * spostato dall'altra parte del filo.
 */
const CHIAVI_RISERVATE = new Set(['file', 'max_size_mb']);

/** Cosa si spedisce. `endpoint` è esplicito: nessun ripiego cablato qui dentro. */
export type RichiestaCaricamento = {
    /** La route che riceve il multipart. Il ripiego lo sceglie il chiamante, non questo modulo. */
    endpoint: string;
    file: File;
    /** Il tetto del campo, se ce n'è uno più stretto di quello della piattaforma. */
    maxSizeMb?: number;
    /**
     * Campi aggiuntivi del multipart (`folder`, `lato`, il token del modulo pubblico…).
     * `file` e `max_size_mb` sono di questo modulo: passarli qui non li sovrascrive, li fa
     * rifiutare con una riga di log (vedi `CHIAVI_RISERVATE`).
     */
    extra?: Record<string, string>;
    /**
     * Header aggiuntivi — in pratica `x-user-id`, per le porte AUTENTICATE.
     *
     * ⚠️ NON è un'aggiunta per comodità: senza, questo modulo sa parlare soltanto alle
     * porte anonime del wizard pubblico, e la prima porta di caricamento del cockpit
     * (il tab «Documento» della scheda staff) avrebbe dovuto riscriversi a mano il
     * `fetch` — cioè ricreare i cinque rami che la testata elenca, quelli che in questo
     * repo sono già stati pagati in produzione. Il conto lo pagherebbe chi carica: un
     * 413 letto come «Caricamento non riuscito. Riprova.» è l'invito a rifare l'unica
     * cosa che non può funzionare.
     *
     * ⚠️ E NON PORTA MAI UN SEGRETO. L'identità di questo repo viaggia come `x-user-id`
     * (un uuid) o come cookie di sessione, che il browser allega da sé: qui dentro non
     * si scrivono token. Un `Content-Type` non si passa nemmeno — il corpo è un
     * `FormData`, e imporlo romperebbe il `boundary` che il browser calcola.
     */
    headers?: Record<string, string>;
};

/**
 * L'esito, in tre casi che chi rende deve distinguere.
 *
 * `troppo-grande` porta il limite in MB perché è l'unico numero che serve per scrivere il
 * messaggio, e chi rende non deve ricalcolarlo (ricalcolarlo con `maxSizeMb` grezzo è il
 * modo di promettere 8 MB che nessuno può mantenere: vedi `limiteUploadMb`).
 */
export type EsitoCaricamento =
    | { esito: 'ok'; path: string }
    | { esito: 'troppo-grande'; limiteMb: number }
    | {
          esito: 'errore';
          stato: number | null;
          messaggioServer?: string;
          /**
           * Il `codice` che la route ha messo accanto alla prosa — e senza il quale la
           * prosa È il problema.
           *
           * ⚠️ FINO AL 12/08/2026 QUESTO CAMPO NON C'ERA, e la testata dichiarava
           * `messaggioServer` come «l'unica stringa che attraversa il confine». Con le
           * sole porte anonime del wizard reggeva; dalla prima porta AUTENTICATA no:
           * `messaggioServer` è la prosa che nasce sul server, dove il locale non
           * esiste, ed è italiana per costruzione. Mostrarla a chi ha l'interfaccia in
           * inglese è **esattamente** il fallimento F2 del collaudo del 2026-07-31
           * («Specificare la sede (scuola_id) per questa operazione» dentro una modale
           * inglese), riaperto da un'altra porta.
           *
           * Il codice si passa a `messaggioDaCorpo` (`@/lib/ui/esito-fetch`), che è
           * l'unico posto in cui vive la regola «codice → catalogo, altrimenti prosa,
           * altrimenti ripiego». Qui non si traduce niente: si smette di buttare via
           * l'unica cosa che rende la traduzione possibile.
           */
          codice?: string;
      };

/**
 * Il messaggio d'errore del SERVER, o `undefined` se non ce n'è uno leggibile.
 *
 * Tre strette, e ognuna ha un motivo:
 *  · si legge solo se il `content-type` è JSON. E il guardiano NON è ridondante rispetto
 *    al `try/catch` qui sotto: il caso vero è un corpo perfettamente parsabile
 *    DICHIARATO testo — `{"error":"FUNCTION_PAYLOAD_TOO_LARGE"}` con
 *    `content-type: text/plain` — che senza guardiano finirebbe sotto il campo di chi sta
 *    fotografando una carta d'identità;
 *  · si legge SOLO il campo `error`, che è quello che scriviamo noi nelle route;
 *  · si tronca a 200 caratteri: quel testo lo scrivono le nostre route, ma nessuno può
 *    garantire che resti corto per sempre, e un dump del server riversato in pagina è
 *    insieme un problema di resa e di privacy. Non lancia mai: è il ramo che gestisce un
 *    errore, non il posto dove aprirne un secondo.
 */
async function erroreDelServer(res: Response): Promise<{ messaggio?: string; codice?: string }> {
    try {
        if (!/application\/json/i.test(res.headers.get('content-type') ?? '')) return {};
        const body = (await res.json()) as { error?: unknown; codice?: unknown } | null;
        const msg = body?.error;
        const cod = body?.codice;
        return {
            messaggio: typeof msg === 'string' && msg !== '' ? msg.slice(0, 200) : undefined,
            // Il codice NON si tronca e non si tocca: è un identificatore, come
            // `PGRST204`. Si controlla solo che sia una stringa non vuota — un codice
            // sconosciuto al catalogo non fa danni, fa semplicemente ricadere
            // `messaggioDaCorpo` sulla prosa, che è il comportamento di prima.
            codice: typeof cod === 'string' && cod !== '' ? cod : undefined,
        };
    } catch {
        // Un corpo dichiarato JSON che JSON non è: non è una notizia — la notizia è lo stato
        // HTTP, che il chiamante ha già. Il `!res.ok` lo registra comunque il patch di `fetch`.
        return {};
    }
}

/**
 * IL MESSAGGIO CON CUI IL GUASTO ENTRA IN `app_log` — e perché non basta `nomeErrore`.
 *
 * La chiave del throttle di `logClient` è `${evento}|${messaggio}|${stato ?? ''}` con
 * `DEDUP_MS = 60_000`: due guasti DIVERSI che producono la stessa stringa non fanno due
 * righe, ne fanno UNA — la seconda viene scartata in silenzio per un minuto. E
 * `nomeErrore` restituisce solo `e.name`, che per quasi tutto vale `Error`: un messaggio
 * costruito su di lui soltanto collassa i rami uno sull'altro, che è la stessa forma del
 * difetto «403 senza corpo» da cui nasce l'intero `src/lib/logging/**`.
 *
 * Una SCADENZA ha quindi la sua riga, col NUMERO dentro: senza il numero non si distingue
 * «il bersaglio è morto» da «il tetto è troppo stretto», e sono riparazioni opposte.
 */
function messaggioDelGuasto(err: unknown): string {
    if (eTimeout(err)) return `modulo-allegato-upload-scaduto: ${TETTO_UPLOAD_MS} ms`;
    return `modulo-allegato-upload-fallito: ${nomeErrore(err)}`;
}

/**
 * Spedisce il file e riporta l'esito. NON LANCIA MAI: chi rende non deve avvolgerla in un
 * `try/catch` per non rompersi, e il ramo d'errore è un valore di ritorno, non un'eccezione.
 */
export async function caricaFile(req: RichiestaCaricamento): Promise<EsitoCaricamento> {
    const { endpoint, file, maxSizeMb, extra, headers } = req;
    const limite = limiteUploadByte(maxSizeMb);

    // ── PRIMA DI SPEDIRE (punto 1 della testata). Sopra il tetto non c'è nessuna risposta
    // nostra da leggere: l'unico posto in cui questo controllo può stare è QUI.
    if (file.size > limite) {
        // Il NOME del file non si logga mai: «carta-identita-maria-rossi.jpg» è un dato
        // personale. La dimensione sì: è un numero, ed è l'unica cosa che serve per sapere se
        // il tetto è tarato bene o se si caricano foto da 12 MB.
        // (Non è una precauzione teorica: a valle non lo fermerebbe nessuno —
        // `redigiPathNelTesto` pretende uno slash iniziale, `sanificaMessaggio` maschera
        // email, codici fiscali e vincoli Postgres, non i nomi di file. Resterebbe 30 giorni
        // in `app_log`, interrogabile in SQL. Il lock è in `__tests__/lib/carica-file.test.ts`.)
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `modulo-allegato-troppo-pesante: ${file.size} byte, limite ${limite}`,
        });
        return { esito: 'troppo-grande', limiteMb: limiteUploadMb(maxSizeMb) };
    }

    // Lo stato dell'ULTIMA risposta ricevuta, per il ramo che lancia (punto 4): una `res.json()`
    // che esplode su una 200 non è «nessuna risposta», ed è la differenza fra sapere che la
    // route ha risposto male e credere che la rete fosse giù.
    let stato: number | null = null;

    try {
        const fd = new FormData();
        fd.append('file', file);
        for (const [k, v] of Object.entries(extra ?? {})) {
            if (CHIAVI_RISERVATE.has(k)) {
                // Si logga il NOME della chiave — che è una costante di questo file, non un
                // dato — e mai il suo VALORE, che arriva dal chiamante e di cui qui non si sa
                // niente. Un rifiuto muto sarebbe la stessa divergenza di prima con un passo
                // in più: il chiamante continuerebbe a credere di aver configurato qualcosa.
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `modulo-allegato-campo-riservato-ignorato: ${k}`,
                });
                continue;
            }
            fd.append(k, v);
        }
        // `if (maxSizeMb)` e non `!== undefined`: uno zero non è un tetto, è l'assenza di tetto,
        // e spedirlo farebbe rifiutare dalla route ogni file.
        if (maxSizeMb) fd.append('max_size_mb', String(maxSizeMb));

        // `headers` si omette quando non ce n'è, invece di passare un oggetto vuoto: un
        // `headers: {}` è innocuo oggi, ma è anche la riga che fa credere a chi legge
        // che questo modulo componga sempre degli header suoi. Non ne ha nessuno.
        const init: RequestInit = headers
            ? { method: 'POST', body: fd, headers }
            : { method: 'POST', body: fd };
        // ⚠️ QUI C'ERA UN `?? init`, e la sua giustificazione descriveva un comportamento
        // INVENTATO di `conTetto`: «restituisce `undefined` quando l'`input` è una
        // `Request`». Misurato con una sonda su `@/lib/logging/tetto` — `conTetto(new
        // Request(…), init, 30000)` restituisce `init`, identità compresa, sia con un
        // signal del chiamante sia senza. Guardando `tetto.ts`, `conTetto` può tornare
        // `undefined` SOLO se `init` è già `undefined`, e in quel caso `?? init`
        // restituirebbe comunque `undefined`: era codice irraggiungibile difeso da uno
        // scenario impossibile («trasformerebbe questo POST in una GET senza corpo»).
        // Il danno non era il ramo morto: era insegnare una cosa falsa su una primitiva
        // che usa tutto `src/` a chi fosse venuto qui per capirla.
        const res = await fetch(endpoint, conTetto(endpoint, init, TETTO_UPLOAD_MS));
        stato = res.status;

        // ── `res.ok` PRIMA di `res.json()` (punto 2 della testata).
        if (!res.ok) {
            // Il 413 e il file oltre il tetto sono lo STESSO guasto per chi carica, e qui
            // diventano lo stesso esito di proposito: chi rende non deve ricordarsi di
            // trattare il 413 a parte per mostrare il messaggio giusto. Se se lo dimentica,
            // torna «Caricamento non riuscito. Riprova.» — cioè il difetto del 31/07.
            // (Il 413 in `app_log` ci finisce comunque, una volta sola: lo registra il patch di
            // `fetch` in `@/lib/logging/client`, che i 413 li tiene come anomalia. Per questo
            // qui non si logga: due righe per un guasto solo rendono illeggibile il conteggio.)
            if (res.status === 413) return { esito: 'troppo-grande', limiteMb: limiteUploadMb(maxSizeMb) };
            const { messaggio, codice } = await erroreDelServer(res);
            // I due campi si omettono quando non ci sono, invece di comparire come
            // `undefined`: chi legge l'esito distingue «il server non ha detto niente»
            // da «ha detto una stringa vuota» guardando la PRESENZA della chiave.
            return {
                esito: 'errore',
                stato: res.status,
                ...(messaggio === undefined ? null : { messaggioServer: messaggio }),
                ...(codice === undefined ? null : { codice }),
            };
        }

        const json: unknown = await res.json();
        const path = (json as { path?: unknown } | null)?.path;
        // Punto 3: una 200 senza `path` non è un successo. Si logga QUI, con un messaggio
        // proprio, invece di lanciare per cadere nel `catch`: là sotto la sua identità
        // sarebbe evaporata in un `Error` generico (vedi `messaggioDelGuasto`), e il guasto
        // «che nessuno si accorge di aver perso» sarebbe stato anche irrintracciabile in SQL.
        if (typeof path !== 'string' || path === '') {
            logClient({ livello: 'error', evento: 'fetch', messaggio: 'modulo-allegato-senza-path' });
            return { esito: 'errore', stato: res.status };
        }
        return { esito: 'ok', path };
    } catch (err) {
        // Un catch che non logga è un bug: il caricamento fallito è invisibile a chi non ha in
        // mano il dispositivo. `logClient` redige i path nel testo e non lancia mai.
        logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: messaggioDelGuasto(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
        return { esito: 'errore', stato };
    }
}
