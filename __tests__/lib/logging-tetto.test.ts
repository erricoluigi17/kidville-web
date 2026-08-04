import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/**
 * IL TETTO DI TEMPO — e il fatto che le STRADE siano DUE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * LA STORIA, ed è il motivo per cui questo file esiste separato dagli altri due.
 *
 * Il 2026-08-03, di mattina, `src/lib/logging/external.ts` ha ricevuto un tetto di tempo di
 * default. La misura che l'ha imposto: un server che ACCETTA la connessione e non risponde mai
 * tiene appesa la `fetch` **150 secondi senza eccezione**, perché `fetch` non ha nessun timeout
 * di suo. Correzione giusta, misurata, con i suoi test.
 *
 * Il suo GEMELLO non l'ha ricevuto. `src/lib/logging/supabase-fetch.ts` — stesso modulo, stessa
 * primitiva, citato da `external.ts` stesso — è rimasto senza: zero occorrenze di
 * `AbortSignal.timeout`, e un commento che diceva «Argomenti INTATTI. Non si tocca `init` (né lo
 * si copia)». Da lì passano **tutte** le chiamate PostgREST e auth dell'applicazione: un Supabase
 * che accetta e tace appendeva la route esattamente come faceva un provider. Col gate verde,
 * perché nessun test guardava la seconda strada.
 *
 * È la lezione già pagata in questo repo su un altro incidente (PUT avvisi senza gate di sede,
 * 1 OTP su 4 senza tetto): **una regola valida per due strade deve vivere in un posto solo**.
 * Perciò la correzione non è "copiare il tetto anche di là": è estrarre la primitiva in
 * `src/lib/logging/tetto.ts` e farla usare da entrambe. E questo file è il test che tiene
 * insieme le due strade — quello che nessuno aveva, e la cui assenza è tutto il difetto.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');
const LOGGING = path.join(RADICE, 'src/lib/logging');

function sorgente(file: string): string {
    return fs.readFileSync(path.join(LOGGING, file), 'utf8');
}

/**
 * Il sorgente SENZA commenti. Serve perché in questi file la primitiva si NOMINA parecchio —
 * `external.ts` e `supabase-fetch.ts` spiegano entrambi, e devono spiegare, perché il tetto sta
 * altrove. Un lock che contasse le menzioni sarebbe rosso per la documentazione che rende
 * comprensibile la correzione: si guarda il CODICE.
 *
 * Il `//` di uno SCHEMA non è un commento: senza l'esclusione del `:` che lo precede, una riga
 * con `'https://…'` verrebbe troncata e il lock leggerebbe metà file convinto di averlo letto
 * tutto — cioè passerebbe senza guardare, che è il modo in cui un lock muore.
 */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. LOCK — la primitiva vive in UN POSTO SOLO, e il lock guarda TUTTO `src/`.
 *
 * È il lock che avrebbe visto il difetto W7 il giorno stesso. Non verifica un comportamento:
 * verifica che la regola non possa TORNARE a esistere in una copia sola.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ IL PERIMETRO È CAMBIATO (2026-08-03, sera). Nella sua prima stesura questo lock
 * scandiva la sola cartella `src/lib/logging/`. Era il perimetro del difetto che aveva appena
 * corretto, e per quello bastava — ma una primitiva di tetto scritta ALTROVE gli era invisibile.
 *
 * E ne esisteva già una: `conTettoDiTempo` / `TETTO_ACCESSO_MS` in `src/lib/auth/errore-accesso.ts`,
 * scritta nello stesso ciclo, con lo stesso nome-concetto e un meccanismo diverso. Due primitive
 * omonime e un lock che ne vede una sola sono la premessa esatta dell'incidente da cui questo
 * file nasce: due strade, una regola sola scritta su una, e nessun test che le guardi insieme.
 *
 * Adesso il perimetro è `src/` intero, e le primitive sono DICHIARATE: averne due è legittimo —
 * fanno cose diverse — ma è una decisione, non un'abitudine, e sta scritta qui sotto.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ COSA QUESTO LOCK **NON** COPRE, e va saputo prima di fidarsene:
 *
 *  · **I NUMERI, tranne il loro ordine di grandezza.** Quanto aspetta un provider o un'area è
 *    una decisione che vive accanto alla sua ragione (lo dice la testata di `tetto.ts`): qui si
 *    verifica solo che nessun tetto dichiarato superi i 30 secondi, non che sia quello giusto.
 *  · **Le attese che non sono tetti.** `setTimeout` per uno strozzamento (`news/digest.ts`, 500 ms
 *    fra un'email e l'altra), per un anti-flash della UI (`GlobalLoader`), per un TTL: non sono
 *    scadenze su una chiamata e non entrano nell'inventario. Il rilevatore le ignora di proposito
 *    — includerle riempirebbe la lista di rumore e la renderebbe illeggibile, che è il modo in
 *    cui un inventario smette di essere letto.
 *  · **`e2e/`, `scripts/`, `supabase/`, i flow Maestro.** Fuori da `src/`: non finiscono nel
 *    prodotto.
 *  · **Il tetto di PIATTAFORMA.** Vercel taglia comunque la funzione: un tetto più alto del suo
 *    non scatta mai. È il motivo del limite assoluto in fondo a questo file, non una copertura.
 *  · **Che il tetto sia EFFICACE su ogni chiamata.** Il lock vede che la primitiva è importata e
 *    invocata; che il `signal` arrivi davvero fino a `fetch` lo dimostrano le misure contro un
 *    server muto (qui sotto, e in `__tests__/lib/middleware-tetto.test.ts` per il middleware).
 *  · **I client Supabase costruiti a mano.** Quello è l'altro lato della stessa moneta e ha il
 *    suo lock: `__tests__/architecture/supabase-client-strumentato.test.ts`.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Tutti i sorgenti di `src/`, in cammino relativo alla radice. */
function sorgentiDiSrc(dir = SRC): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) { out.push(...sorgentiDiSrc(assoluto)); continue; }
        if (!/\.tsx?$/.test(voce.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

const FILE_SRC = sorgentiDiSrc();
const CODICE_SRC = new Map<string, string>(
    FILE_SRC.map((f) => [f, senzaCommenti(fs.readFileSync(path.join(RADICE, f), 'utf8'))]),
);

function contengono(ago: string): string[] {
    return [...CODICE_SRC.entries()].filter(([, src]) => src.includes(ago)).map(([f]) => f).sort();
}

/**
 * Come `contengono`, ma con una REGEX — e non è un vezzo: è la falla che questo lock aveva.
 *
 * Il rilevatore era `src.includes('AbortSignal.timeout')`, cioè una stringa letterale. Misurato:
 * `const { timeout: scadenza } = AbortSignal` e `AbortSignal['timeout'](1_800_000)` sono lo
 * STESSO meccanismo, scrivono un tetto a mano in un file qualunque di `src/` e il lock restava
 * verde — 32/32 — con mezz'ora di attesa dentro. Cioè il lock non impediva affatto ciò che il
 * suo messaggio d'errore dichiara di impedire: bastava scrivere l'accesso in un altro modo.
 */
function contengonoRegex(...rx: RegExp[]): string[] {
    return [...CODICE_SRC.entries()]
        .filter(([, src]) => rx.some((r) => r.test(src)))
        .map(([f]) => f)
        .sort();
}

/**
 * `AbortSignal.timeout` in TUTTE le grafie con cui JavaScript permette di raggiungerlo: accesso
 * col punto (anche spaziato), accesso a indice con la stringa, destrutturazione (con o senza
 * rinomina). Sono forme diverse dello stesso meccanismo, e un lock che ne vede una sola è un
 * lock che si aggira senza saperlo — basta conoscere JavaScript.
 */
const ABORTSIGNAL_TIMEOUT = [
    /AbortSignal\s*(?:\.\s*timeout|\[\s*['"]timeout['"]\s*\])/,
    /\{[^}]*\btimeout\b[^}]*\}\s*=\s*AbortSignal/,
];

/**
 * UN TETTO SCRITTO A MANO: `new AbortController()` più un `setTimeout` che ne chiama `.abort()`.
 *
 * È la TERZA primitiva possibile, e prima di questa riga non la vedeva nessuno: il lock cercava
 * `Promise.race(` e `AbortSignal.timeout`, cioè le due forme che qualcuno aveva già scritto. Un
 * controller e un timer sono esattamente la stessa cosa — una scadenza che interrompe una
 * chiamata — assemblata a mano, e in `src/` ce n'è già una (la sonda della pagina offline).
 */
const TETTO_A_MANO = /setTimeout\s*\([\s\S]{0,200}?\.abort\s*\(/;

interface Primitiva {
    /** Il nome leggibile del meccanismo, per il messaggio d'errore. */
    meccanismo: string;
    /** Come si riconosce nel sorgente. È anche il rilevatore dell'esclusività. */
    rilevatore: RegExp[];
    perche: string;
}

/**
 * LE PRIMITIVE DI TETTO DEL REPO. Sono TRE, e nessuna è un doppione: si aggiunge qui solo ciò
 * che è davvero un meccanismo diverso, con scritto PERCHÉ non può essere il primo.
 *
 * ⚠️ LA TERZA È COMPARSA IL 2026-08-03, SERA, e non perché qualcuno l'abbia scritta quel giorno:
 * `src/app/offline/script-offline.ts` assemblava un tetto a mano da settimane, e questo lock non
 * lo vedeva perché cercava soltanto le due forme che conosceva. È il difetto del lock, non del
 * file — ed è la ragione per cui adesso ogni primitiva porta il proprio RILEVATORE e l'elenco è
 * verificato per esclusività, invece di essere una lista di nomi che qualcuno ricorda.
 */
const PRIMITIVE_DI_TETTO = new Map<string, Primitiva>([
    ['src/lib/logging/tetto.ts', {
        meccanismo: 'AbortSignal.timeout',
        rilevatore: ABORTSIGNAL_TIMEOUT,
        perche:
            'Il tetto del TRASPORTO: attacca una scadenza all\'`init` di una `fetch` e la '
            + 'INTERROMPE davvero, liberando la connessione. È la forma giusta ovunque il '
            + 'chiamante possa passare un `init` — i provider esterni, i client Supabase, il '
            + 'middleware, il calcolo del codice fiscale nel browser.',
    }],
    ['src/lib/auth/errore-accesso.ts', {
        meccanismo: 'Promise.race',
        rilevatore: [/Promise\.race\(/],
        perche:
            'Il budget della SEQUENZA DI ACCESSO, e NON può essere un `AbortSignal`: '
            + '`signInWithPassword()` non accetta un signal, e il `fetch` lo possiede il client '
            + 'Supabase del browser, che in quest\'app è un SINGLETON condiviso da tutte le '
            + 'pagine. Infilargli un segnale per la sola login vorrebbe dire riscrivere il '
            + 'trasporto dell\'intera applicazione per un caso limite di una schermata. Qui la '
            + 'richiesta non viene annullata: viene ABBANDONATA, e la differenza è dichiarata '
            + 'nella testata di `conTettoDiTempo`. Meccanismo diverso, mestiere diverso: non è '
            + 'una copia di `tetto.ts` e non va unificata con essa.',
    }],
    ['src/app/offline/script-offline.ts', {
        meccanismo: 'AbortController + setTimeout',
        rilevatore: [TETTO_A_MANO],
        perche:
            'La sonda di rete della pagina `/offline`, e qui `conTetto` NON è utilizzabile: la '
            + 'stessa sonda esiste due volte — una in TS per React, una inlinata come STRINGA '
            + 'ES5 dentro il documento — perché `/offline` viene servita dalla CacheStorage '
            + 'senza il bundle di Next, senza import e senza idratazione. La versione inline '
            + 'non può importare niente per costruzione, e le due devono restare equivalenti '
            + '(`__tests__/offline/equivalenza-offline.test.ts`). In più `AbortSignal.timeout` '
            + 'è recente (Safari 16 / Chrome 103) e questa è precisamente la pagina che deve '
            + 'funzionare sulle WebView vecchie, dove `AbortController` c\'è da sempre. Il '
            + 'tetto è 3 secondi: una sonda che non risponde vale «non c\'è rete».',
    }],
]);

/**
 * L'INVENTARIO DELLE `fetch` NUDE, lato server — chi chiama la rete SENZA passare dal tetto.
 *
 * Perché serviva, e perché il lock senza di esso era mezzo lock: qui sotto si elencano i
 * CONSUMATORI del tetto (controllo positivo), ma nessuno enumerava il complemento. Una strada
 * NUOVA — la settima di domani — nasceva quindi invisibile: non essendo in `CONSUMATORI_DEL_TETTO`
 * non c'era niente da violare, e non essendo in nessun altro elenco non c'era niente da dichiarare.
 *
 * PERIMETRO: `src/app/api/**` e `src/lib/**`. Fuori restano `src/app/(dashboard)/**` e
 * `src/components/**` — pagine e componenti, che parlano con le NOSTRE route e non con un host
 * di terzi; e `src/lib/logging/**`, che il tetto lo IMPLEMENTA (il suo `globalThis.fetch` è la
 * chiamata vera). Stessa esenzione, e per la stessa ragione, di `provider-esterni-osservati.test.ts`.
 *
 * ⚠️ ESSERE IN QUESTA LISTA NON È UN CONDONO: è una decisione scritta, che il lock rilegge. Le
 * dieci voci di browser ci stanno perché la loro `fetch` è una chiamata a una nostra route
 * relativa — lì il tetto vive dall'altra parte, dentro la route, e il browser ha già i suoi
 * annullamenti (l'utente chiude la pagina). La prima voce è invece debito vero.
 */
const FETCH_SENZA_TETTO = new Map<string, string>([
    ['src/app/api/admin/apply-enrollment-migration/route.ts',
        'DEBITO DICHIARATO, non un falso positivo: sei `fetch` a mano verso `/rest/v1/rpc/exec_sql` '
        + 'e `/pg/query` con la service-role key negli header — nessun tetto, nessuna riga. La '
        + 'ragione per cui non è stata ricondotta al factory sta già scritta per esteso in '
        + '`__tests__/architecture/supabase-client-strumentato.test.ts` (voce `FETCH_VERSO_SUPABASE`): '
        + '`/pg/query` non ha equivalente in supabase-js, e la route è `sealDangerous`, cioè 404 in '
        + 'produzione. Il rischio residuo è sviluppo e preview, dove appende chi la invoca. Va '
        + 'rimossa o ricondotta, non condonata.'],
    ['src/lib/auth/logout.ts',
        'BROWSER: `POST /api/auth/logout`, una nostra route. E il suo esito non conta — il logout '
        + 'prosegue comunque con `signOut()` locale.'],
    ['src/lib/auth/use-child-school-type.ts',
        'BROWSER: hook React su `/api/parent/primaria`, una nostra route — il tetto vive dall\'altra '
        + 'parte, dentro la route, dove passa dal client Supabase strumentato.'],
    ['src/lib/auth/use-parent-identity.ts',
        'BROWSER: hook React su `/api/parent/students`, una nostra route. Stessa forma, stesso '
        + 'motivo: il tetto sta nella route, non nel chiamante.'],
    ['src/lib/auth/use-session-identity.ts',
        'BROWSER: hook React su `/api/me`, una nostra route. Stessa forma, stesso motivo: il tetto '
        + 'sta nella route, non nel chiamante.'],
    ['src/lib/auth/use-teacher-gradi.ts',
        'BROWSER: hook React su `/api/primaria/me`, una nostra route. Stessa forma, stesso '
        + 'motivo: il tetto sta nella route, non nel chiamante. (`/api/diary/config` non si '
        + 'chiede più da qui: è passata alla cache condivisa `src/lib/diary/config-cache.ts`.)'],
    ['src/lib/context/admin-identity.tsx',
        'BROWSER: contesto React su `/api/primaria/me`, una nostra route. Stessa forma, stesso '
        + 'motivo: il tetto sta nella route, non nel chiamante.'],
    ['src/lib/diary/config-cache.ts',
        'BROWSER: `GET /api/diary/config`, una nostra route, con la cache di promesse che '
        + 'impedisce alle tre parti della pagina del diario di chiederla tre volte (sei con '
        + 'StrictMode). Stessa forma, stesso motivo: il tetto sta nella route, non nel chiamante.'],
    ['src/lib/native/camera.ts',
        'NON È RETE: `fetch(dataUrl)` su una `data:` URL è il modo standard di trasformare in `Blob` '
        + 'la foto che il plugin ha già in memoria. Non esce niente dal dispositivo, non c\'è nessun '
        + 'bersaglio che possa tacere.'],
    ['src/lib/offline/read-cache.ts',
        'BROWSER: è il wrapper di lettura con fallback su IndexedDB delle pagine genitore, e l\'`url` '
        + 'che riceve è sempre una nostra route relativa. Un tetto qui sarebbe per di più il '
        + 'contrario di ciò che serve: quando la rete manca, la pagina deve servire la copia salvata, '
        + 'e ci arriva dal `catch` — che scatta anche senza tetto.'],
    ['src/lib/offline/syncEngine.ts',
        'BROWSER: cinque `fetch` verso `/api/**` nostre, dal motore di sincronizzazione offline. '
        + 'Nessuna esce verso un host di terzi (già verificato in `supabase-client-strumentato.test.ts`).'],
    ['src/lib/push/native-register.ts',
        'BROWSER: registrazione e cancellazione del token su `/api/push/subscribe`, una nostra '
        + 'route. Stessa forma, stesso motivo: il tetto sta nella route, non nel chiamante.'],
    ['src/lib/sezioni/educator-sections-cache.ts',
        'BROWSER: `GET /api/educator-sections`, una nostra route, con la cache di promesse che '
        + 'la fa chiedere una volta sola per ingresso in pagina. Stessa forma, stesso motivo: il '
        + 'tetto sta nella route, non nel chiamante.'],
]);

/**
 * CHI PRENDE IL TETTO DALLA PRIMITIVA DEL TRASPORTO. Controllo POSITIVO: un lock che verifica
 * solo assenze resta verde anche quando il codice sparisce.
 */
const CONSUMATORI_DEL_TETTO = new Map<string, string>([
    ['src/lib/logging/external.ts', 'i 13 provider esterni'],
    ['src/lib/logging/supabase-fetch.ts', 'tutte le chiamate PostgREST/Storage/auth delle route'],
    ['src/middleware.ts', 'la porta da cui passa OGNI pagina e OGNI route API'],
    ['src/lib/utils/fiscalCodeApi.ts', 'il calcolo del codice fiscale, che gira nel browser'],
]);

/**
 * I FILE che possono ospitare un tetto di tempo, e perché quel numero vive lì.
 *
 * I NUMERI non stanno qui: «quanto aspetta» è una decisione che vive accanto alla sua ragione,
 * lo dice la testata di `tetto.ts`. Qui sta l'elenco dei posti in cui è lecito prenderla.
 */
const TETTI_DICHIARATI = new Map<string, string>([
    ['src/lib/logging/external.ts', 'quanto aspetta ciascun provider esterno'],
    ['src/lib/logging/supabase-fetch.ts', 'quanto aspetta ciascuna area di Supabase'],
    ['src/lib/auth/errore-accesso.ts', 'il budget dell\'intera sequenza di accesso, lato browser'],
    ['src/middleware.ts', 'il budget di `getUser()` sulla porta di ogni richiesta'],
    ['src/lib/utils/fiscalCodeApi.ts', 'il calcolo del codice fiscale, con un fallback locale che aspetta'],
    ['src/app/offline/script-offline.ts',
        'la sonda di rete della pagina `/offline` e l\'ultima attesa di React. È entrata '
        + 'nell\'inventario il 2026-08-03 non perché fosse nuova, ma perché la regola qui sotto '
        + 'pretendeva che una costante si chiamasse `TETTO…`: `TIMEOUT_SONDA_MS` non ci entrava.'],
    ['src/lib/security/rate-limit.ts',
        'quanto il tetto per IP aspetta il contatore condiviso su Postgres prima di degradare al '
        + 'conteggio locale (2026-08-04). È il tetto più corto del repo — 250 ms — e il numero '
        + 'basso È la decisione: da queste rotte passano le domande d\'iscrizione delle famiglie, '
        + 'e un rate-limiter che aspetta mezzo secondo il proprio contatore ha già fatto più danno '
        + 'di quanto ne eviti. Scaduto il tempo non si blocca e non si apre: si conta in locale, '
        + 'cioè col tetto di ieri, e si lascia una riga `error` perché il fatto non passi in '
        + 'silenzio. I due MECCANISMI non stanno qui: sono presi da `tetto.ts` '
        + '(`segnaleConTetto`) e da `errore-accesso.ts` (`conTettoDiTempo`) — la prima stesura li '
        + 'aveva riscritti a mano ed è questo lock ad averla respinta.'],
]);

/**
 * `const NOME = <espressione>;` → nome e valore SCRITTO, per le costanti di modulo in MAIUSCOLO.
 *
 * ⚠️ IL NOME NON È PIÙ `TETTO…`, ED È IL PUNTO. La regex di prima era
 * `/const\s+(TETTO[A-Z_]*)\s*=\s*([0-9_]+)\s*;/`, cioè l'inventario vedeva un tetto solo se chi
 * lo introduceva sceglieva il nome che il lock si aspettava. Un tetto da mezz'ora chiamato
 * `SCADENZA_CONSEGNA_MS` non entrava né nel controllo «nessuno è smisurato» né nel confronto con
 * `TETTI_DICHIARATI`: il lock vedeva il difetto solo con la collaborazione di chi lo scriveva.
 * Misurato, e infatti aveva già lasciato fuori `TIMEOUT_SONDA_MS` di `script-offline.ts`.
 *
 * ⚠️ E NEMMENO IL VALORE È PIÙ UN LETTERALE, che era l'altra metà della stessa fessura. Finché il
 * gruppo del valore era `([0-9_]+)`, un tetto scritto come ESPRESSIONE non entrava mai nel
 * confronto con `MAI_OLTRE_MS`: misurato il 2026-08-03, aggiungendo a `src/middleware.ts` un
 * `const TETTO_LENTO_MS = 15 * 60 * 1000;` — quindici minuti, trenta volte il taglio di
 * piattaforma, cioè funzionalmente nessun tetto — la suite restava 32/32. La copertura dichiarata
 * («nessuno è smisurato») valeva solo per chi sceglieva di scrivere un numero secco, e niente lo
 * imponeva. Adesso si cattura tutto ciò che sta fra `=` e `;` sulla riga, e a valutarlo è
 * `valoreDelTetto`: ciò che non è aritmetica di numeri diventa ROSSO, non invisibile.
 */
const COSTANTE_DI_MODULO = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/g;

/**
 * Il valore in millisecondi di un'espressione di tetto, o `null` se non è aritmetica di numeri.
 *
 * Somme e prodotti di letterali passano (`15_000`, `15 * 60 * 1000`, `30 * 1000 + 500`): scrivere
 * `15 * 60 * 1000` è un modo LEGITTIMO — e più leggibile — di scrivere un numero, e vietarlo
 * sposterebbe il difetto invece di chiuderlo. Non passa nient'altro: nessun identificatore,
 * nessuna chiamata, nessuna `env`. Un tetto che dipende da un'altra costante è un tetto che questo
 * inventario non può misurare, e il posto dove dirlo è qui — rosso — non un commento che nessuno
 * rilegge.
 */
function valoreDelTetto(espressione: string): number | null {
    const pulito = espressione.replace(/_/g, '').trim();
    if (!/^[0-9+*\s]+$/.test(pulito)) return null;
    const somma = pulito.split('+').reduce(
        (acc, addendo) => acc + addendo.split('*').reduce((p, n) => p * Number(n.trim()), 1),
        0,
    );
    return Number.isFinite(somma) ? somma : null;
}

/**
 * Le parole che, in un nome di costante, dichiarano una SCADENZA.
 *
 * PERCHÉ NON C'È `MS` DA SOLO, che pure sarebbe la scelta ovvia — ed è una deviazione
 * deliberata da come questa correzione era stata chiesta. `MS` significa «una durata», non «un
 * tetto»: nel repo di oggi tirerebbe dentro `DEDUP_MS` e `FINESTRA_MS` (finestre di dedup e di
 * rate limit, entrambe 60.000 — cioè ROSSE contro il limite dei 30 s pur non essendo scadenze),
 * `MS_GIORNO` (86.400.000: un'unità di misura), i quattro ritardi anti-flash di `GlobalLoader`.
 * Sarebbero otto voci di rumore, il limite superiore andrebbe disattivato per la maggioranza di
 * esse, e un inventario che chiede di dichiarare tutto smette di essere letto — che è il modo
 * in cui un lock muore restando verde.
 *
 * E non lascia un buco, perché un tetto NON È UN NUMERO: è un numero più un MECCANISMO, e i
 * meccanismi sono tutti e tre coperti qui sopra in ogni loro grafia (`AbortSignal.timeout` e i
 * suoi alias, `Promise.race`, `AbortController` + `setTimeout`). Un `const CONSEGNA_MS =
 * 1_800_000` che non fosse collegato a nessuno dei tre non interrompe niente: non è un tetto,
 * è un numero. Questo inventario è la SECONDA rete, quella che tiene leggibile la prima.
 */
const PAROLE_DI_SCADENZA = ['TETTO', 'TIMEOUT', 'SCADENZA', 'ATTESA'];

/**
 * I nomi che portano una parola di scadenza ma NON contano un tempo. Uno per uno, col perché:
 * un'eccezione senza ragione scritta è un condono, e i condoni si moltiplicano.
 */
const NON_SONO_TEMPI = new Map<string, string>([
    ['src/lib/validation/avvisi.ts:TETTO_CLASSI_AVVISO',
        'è un CONTEGGIO — quante classi può indirizzare un avviso — non dei millisecondi. Il '
        + 'nome dice «tetto» nel senso di massimale.'],
    ['src/lib/auth/errore-accesso.ts:ESITO_TIMEOUT',
        'è una STRINGA di esito (`\'timeoutAccesso\'`), cioè il nome del caso che la UI mostra '
        + 'quando il budget scade — non il budget. Entra nell\'inventario perché il rilevatore '
        + 'guarda i nomi, e «TIMEOUT» in un nome è quasi sempre un tempo: qui no.'],
    ['src/lib/auth/errore-accesso.ts:ESITO_TIMEOUT_DOPO_ACCESSO',
        'stessa cosa (`\'timeoutDopoAccesso\'`): l\'esito «le credenziali erano buone ma il '
        + 'seguito non è arrivato in tempo». Una stringa, non dei millisecondi.'],
]);

function scadenza(nome: string): boolean {
    return nome.split('_').some((p) => PAROLE_DI_SCADENZA.some((w) => p.includes(w)));
}

/** I file DICHIARATI come primitiva con un certo meccanismo, in ordine. */
function conMeccanismo(meccanismo: string): string[] {
    return [...PRIMITIVE_DI_TETTO.entries()]
        .filter(([, p]) => p.meccanismo === meccanismo)
        .map(([f]) => f)
        .sort();
}

describe('lock — il tetto è scritto in un posto solo, e il lock guarda tutto `src/`', () => {
    it('la misura vede davvero il codice (autoinganno: se lo scanner non trova niente, il lock cade)', () => {
        // Senza, un errore nel path renderebbe VERDI tutte le regole qui sotto: «zero file
        // scanditi» e «zero violazioni» hanno lo stesso colore.
        expect(FILE_SRC.length).toBeGreaterThan(500);
        expect(contengono('conTetto(').length).toBeGreaterThanOrEqual(CONSUMATORI_DEL_TETTO.size);
    });

    it('`AbortSignal.timeout` è RAGGIUNTO in un solo file di TUTTO `src/`, in QUALUNQUE grafia', () => {
        // Il rilevatore era la stringa letterale `AbortSignal.timeout`. Misurato: con
        // `const { timeout: scadenza } = AbortSignal` — o con `AbortSignal['timeout'](…)` — si
        // scriveva un tetto da mezz'ora in un file nuovo di `src/` e la suite restava 32/32
        // verde. Cioè il lock lasciava passare ESATTAMENTE lo scenario che il suo messaggio
        // d'errore dichiara di impedire: bastava conoscere JavaScript.
        expect(
            contengonoRegex(...ABORTSIGNAL_TIMEOUT),
            'Qualcuno ha ricominciato a scrivere il tetto a mano: fra sei mesi una delle strade '
            + 'sarà di nuovo indietro rispetto alle altre, col gate verde. Si usa `conTetto` da '
            + '`@/lib/logging/tetto` — che non importa niente e gira anche sull\'Edge e nel browser.',
        ).toEqual(['src/lib/logging/tetto.ts']);
    });

    it('gli ALIAS di `AbortSignal.timeout` sono davvero riconosciuti (autoinganno del rilevatore)', () => {
        // Un rilevatore che non si prova su ciò che deve trovare è una regex che nessuno ha
        // letto. Queste tre righe sono le grafie MISURATE con cui il lock precedente si
        // aggirava: se una smette di essere riconosciuta, il buco torna in silenzio.
        const evasioni = [
            "const { timeout: scadenza } = AbortSignal; scadenza(1_800_000);",
            "const s = AbortSignal['timeout'](1_800_000);",
            'const s = AbortSignal . timeout(1_800_000);',
            'const { timeout } = AbortSignal;',
        ];
        for (const riga of evasioni) {
            expect(ABORTSIGNAL_TIMEOUT.some((r) => r.test(riga)), `non riconosciuta: ${riga}`).toBe(true);
        }
        // E non si accende su ciò che non è un tetto: `timeout` è una parola comune.
        for (const innocua of ['const { timeout } = opzioni;', 'clearTimeout(timer);']) {
            expect(ABORTSIGNAL_TIMEOUT.some((r) => r.test(innocua)), `falso positivo: ${innocua}`).toBe(false);
        }
    });

    it('non è comparsa una primitiva di tetto NUOVA (una corsa contro un timer)', () => {
        // `Promise.race` in questo repo significa una cosa sola: qualcosa corre contro una
        // scadenza. Se ne compare una in un file non dichiarato, o è un tetto scritto a mano —
        // e allora va ricondotto — oppure è un meccanismo davvero nuovo, e allora va DICHIARATO
        // qui sopra col suo perché. Le primitive di oggi hanno pagato quella spiegazione.
        expect(
            contengono('Promise.race('),
            'Corsa contro un timer in un file che non dichiara di essere una primitiva di tetto.',
        ).toEqual(conMeccanismo('Promise.race'));
    });

    it('né una TERZA FORMA: un `AbortController` con un `setTimeout` che lo interrompe', () => {
        // È un tetto a tutti gli effetti — una scadenza che interrompe una chiamata — solo
        // assemblata a mano invece che presa da `conTetto`. Il lock non la vedeva: cercava
        // `Promise.race(` e la stringa `AbortSignal.timeout`, cioè le due forme che qualcuno
        // aveva GIÀ scritto. E intanto in `src/` ce n'era una da settimane
        // (`script-offline.ts`), che per questo è stata dichiarata fra le primitive col suo
        // perché — non condonata: è la sola pagina che deve funzionare senza il bundle di Next
        // e su WebView dove `AbortSignal.timeout` non esiste.
        expect(
            contengonoRegex(TETTO_A_MANO).filter((f) => CODICE_SRC.get(f)!.includes('new AbortController(')),
            'Un tetto scritto a mano con `new AbortController()` + `setTimeout(() => …abort())`. '
            + 'È la terza forma della stessa cosa: si usa `conTetto` da `@/lib/logging/tetto`, '
            + 'oppure la si dichiara in `PRIMITIVE_DI_TETTO` scrivendo perché non può esserlo.',
        ).toEqual(conMeccanismo('AbortController + setTimeout'));
    });

    it('le `fetch` NUDE lato server sono un elenco chiuso, e ognuna dice perché', () => {
        // Il complemento del controllo positivo qui sotto: quello verifica che le strade
        // DICHIARATE prendano il tetto, questo verifica che non ne nascano di NUOVE senza che
        // nessuno lo dica. Era il buco: una `fetch` a mano in una route nuova non violava
        // niente, perché non essendo in nessun elenco non c'era niente da violare.
        const nude = [...CODICE_SRC.entries()]
            .filter(([f]) => f.startsWith('src/app/api/') || f.startsWith('src/lib/'))
            .filter(([f]) => !f.startsWith('src/lib/logging/'))
            .filter(([, src]) => /(?<![.\w$])fetch\s*\(/.test(src) && !src.includes('conTetto('))
            .map(([f]) => f)
            .sort();

        expect(nude,
            'Una `fetch` lato server senza tetto, in un file che non lo dichiara. O passa da '
            + '`externalFetch` / dal client Supabase strumentato (che il tetto ce l\'hanno), o '
            + 'entra in `FETCH_SENZA_TETTO` con scritto perché non può.',
        ).toEqual([...FETCH_SENZA_TETTO.keys()].sort());

        // Autoinganno: se il rilevatore smettesse di trovare `fetch(`, l'uguaglianza qui sopra
        // resterebbe vera solo svuotando anche la mappa — ma un errore di perimetro (un path
        // sbagliato, un filtro troppo largo) la renderebbe verde su una lista vuota.
        expect(nude.length, 'lo scanner delle `fetch` non trova più niente').toBeGreaterThan(5);
        for (const [f, perche] of FETCH_SENZA_TETTO) {
            expect(perche.length, `la ragione di ${f} non è scritta`).toBeGreaterThan(60);
        }
    });

    it('ogni primitiva dichiarata esiste, è motivata e usa il meccanismo che dichiara', () => {
        for (const [file, p] of PRIMITIVE_DI_TETTO) {
            const src = CODICE_SRC.get(file);
            expect(src, `primitiva dichiarata ma sparita: ${file}`).toBeDefined();
            // Si verifica col RILEVATORE, non con la stringa del nome: il meccanismo di
            // `script-offline.ts` non è una parola che compare nel sorgente, è una forma.
            expect(p.rilevatore.some((r) => r.test(src as string)),
                `${file} non usa più ${p.meccanismo}`).toBe(true);
            expect(p.perche.length, `la ragione di ${file} non è scritta`).toBeGreaterThan(120);
        }
    });

    it('TUTTE le strade prendono il tetto dalla primitiva condivisa (controllo positivo)', () => {
        // Se una smette di importarlo, o è tornata a scriverselo da sé, o — molto peggio, ed è
        // esattamente ciò che è successo a `supabase-fetch.ts` e poi al middleware — non ce l'ha
        // più affatto.
        for (const [strada, cosaCopre] of CONSUMATORI_DEL_TETTO) {
            const src = CODICE_SRC.get(strada);
            expect(src, `consumatore dichiarato ma sparito: ${strada} (${cosaCopre})`).toBeDefined();
            expect(src as string, `${strada} non importa più il tetto condiviso`)
                .toMatch(/import\s*\{[^}]*conTetto[^}]*\}\s*from\s*'(\.\/tetto|@\/lib\/logging\/tetto)'/);
            expect(src as string, `${strada} non applica più il tetto alla sua fetch`)
                .toContain('conTetto(');
        }
    });

    it('i tetti vivono solo nei file dichiarati, e nessuno è smisurato', () => {
        // Un tetto nuovo in un angolo del repo è la stessa cosa di una primitiva nuova: una
        // decisione presa senza dirlo. E un tetto di mezz'ora è funzionalmente nessun tetto —
        // a tagliare tornerebbe la piattaforma.
        //
        // L'inventario è per FILE e non per NOME, deliberatamente: quanti tetti servano dentro
        // un file che già ne dichiara (un default e un massimo, per dire) è una scelta locale, e
        // pretendere l'elenco esatto dei nomi renderebbe questo lock rosso a ogni raffinamento
        // legittimo — cioè lo trasformerebbe in una tassa da pagare invece che in una guardia.
        // Il rischio VERO è di file: un tetto che compare dove nessuno lo sta guardando.
        const MAI_OLTRE_MS = 30_000;
        const conTetti = new Set<string>();
        const visti: string[] = [];
        for (const [f, src] of CODICE_SRC) {
            for (const m of src.matchAll(COSTANTE_DI_MODULO)) {
                // Il nome deve dichiarare una SCADENZA. `TETTO` da solo non basta a dire che è
                // un tempo (`TETTO_CLASSI_AVVISO = 100` è un massimale di classi), e per
                // simmetria un tempo dichiarato con un'altra parola — `TIMEOUT_…`, `SCADENZA_…`,
                // `ATTESA_…` — entra eccome: era il buco.
                if (!scadenza(m[1])) continue;
                const chiave = `${f}:${m[1]}`;
                visti.push(chiave);
                if (NON_SONO_TEMPI.has(chiave)) continue;
                // IL VALORE DEVE ESSERE MISURABILE. Un tetto scritto in una forma che questo
                // inventario non sa valutare non è «probabilmente a posto»: è un numero che
                // nessuno sta guardando, ed è così che `15 * 60 * 1000` è passato.
                const valore = valoreDelTetto(m[2]);
                expect(
                    valore,
                    `${f}: ${m[1]} = \`${m[2].trim()}\` non è un'espressione numerica, quindi questo `
                    + 'lock non può dire se sta sotto il taglio di piattaforma. Si scrive con dei '
                    + 'numeri (`15_000`, o `15 * 60 * 1000` se è più leggibile); se invece non è un '
                    + 'tempo, va dichiarato in `NON_SONO_TEMPI` con il perché.',
                ).not.toBeNull();
                expect(valore!, `${f}: ${m[1]} = ${valore} ms è oltre il taglio di piattaforma`)
                    .toBeLessThanOrEqual(MAI_OLTRE_MS);
                expect(valore!, `${f}: ${m[1]} non è un tetto`).toBeGreaterThan(0);
                conTetti.add(f);
            }
        }

        // Autoinganno: un filtro sbagliato che non trova più niente renderebbe verdi entrambe
        // le regole qui sotto, perché «zero costanti» e «zero violazioni» hanno lo stesso colore.
        expect(visti.length, 'lo scanner delle costanti di scadenza non trova più niente')
            .toBeGreaterThanOrEqual(TETTI_DICHIARATI.size + NON_SONO_TEMPI.size);
        // E le eccezioni dichiarate devono esistere ancora: una deroga a un nome sparito è una
        // riga che nessuno rileggerà mai.
        for (const chiave of NON_SONO_TEMPI.keys()) {
            expect(visti, `eccezione dichiarata ma sparita: ${chiave}`).toContain(chiave);
        }

        expect(
            [...conTetti].sort(),
            'Un tetto di tempo è comparso in un file che non lo dichiara (o è sparito da uno che '
            + 'lo dichiarava). Un tetto è una decisione: va scritta in `TETTI_DICHIARATI` insieme '
            + 'alla ragione per cui quel file ne ha uno suo.',
        ).toEqual([...TETTI_DICHIARATI.keys()].sort());
    });

    it('il valutatore dei tetti legge le ESPRESSIONI (autoinganno: nel repo di oggi non ce ne sono)', () => {
        // Le tre grafie qui sotto oggi in `src/` non esistono: tutti i tetti sono letterali.
        // Quindi la regola qui sopra resterebbe verde anche con `valoreDelTetto` rotta — «nessuna
        // violazione» e «non so leggere» avrebbero di nuovo lo stesso colore, che è esattamente
        // come `15 * 60 * 1000` era passato. Qui il valutatore si prova su ciò che deve trovare.
        expect(valoreDelTetto('15_000')).toBe(15_000);
        expect(valoreDelTetto(' 15 * 60 * 1000 '), 'quindici minuti scritti come prodotto').toBe(900_000);
        expect(valoreDelTetto('30 * 1000 + 500')).toBe(30_500);
        // E ciò che non è aritmetica di numeri deve dichiararsi non misurabile, NON valere zero:
        // uno zero silenzioso passerebbe il confronto «≤ 30 s» e fallirebbe «> 0» con un messaggio
        // che manda a cercare la cosa sbagliata.
        for (const nonNumerica of ['TETTO_MS_DEFAULT', 'Number(process.env.X) || 1_000', "'timeoutAccesso' as const"]) {
            expect(valoreDelTetto(nonNumerica), `${nonNumerica} non è un numero`).toBeNull();
        }
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. LA PRIMITIVA.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('conTetto — l\'init del chiamante con la scadenza attaccata', () => {
    it('attacca un `AbortSignal` quando il chiamante non ne ha uno', async () => {
        const { conTetto } = await import('@/lib/logging/tetto');

        const out = conTetto('https://x.it', { method: 'POST' }, 1_000)!;

        expect(out.signal).toBeInstanceOf(AbortSignal);
        expect(out.signal!.aborted).toBe(false);
        expect(out.method).toBe('POST'); // l'init del chiamante non si perde per strada
    });

    it('vale anche per chi non passa nessun `init`', async () => {
        const { conTetto } = await import('@/lib/logging/tetto');
        expect(conTetto('https://x.it', undefined, 1_000)!.signal).toBeInstanceOf(AbortSignal);
    });

    it('il numero che arriva ad `AbortSignal.timeout` è ESATTAMENTE il tetto, non un suo multiplo', async () => {
        // L'asserzione che mancava a tutto il blocco. Ogni altro test qui dentro guarda che il
        // signal ci SIA; nessuno guardava QUANTO vale — e un `AbortSignal.timeout(ms * 10)`
        // messo qui dentro lasciava la suite intera verde, mentre in produzione i 15 secondi
        // dell'auth sarebbero diventati 150. Un tetto sbagliato di un ordine di grandezza è
        // indistinguibile da nessun tetto: è il difetto di partenza, tornato dalla porta di
        // servizio.
        const { conTetto } = await import('@/lib/logging/tetto');
        const originale = AbortSignal.timeout;
        const chiesti: unknown[] = [];
        AbortSignal.timeout = ((ms: number) => {
            chiesti.push(ms);
            return originale.call(AbortSignal, ms);
        }) as typeof AbortSignal.timeout;
        try {
            conTetto('https://x.it', undefined, 1_234);
            conTetto('https://x.it', { method: 'POST' }, 4_000);
            // Il signal del chiamante vince: lì `AbortSignal.timeout` non si chiama affatto.
            conTetto('https://x.it', { signal: new AbortController().signal }, 9_000);
        } finally {
            AbortSignal.timeout = originale;
        }

        expect(chiesti).toEqual([1_234, 4_000]);
    });

    it('il signal del chiamante VINCE, e non gliene mettiamo un secondo', async () => {
        const { conTetto } = await import('@/lib/logging/tetto');
        const suo = new AbortController().signal;

        expect(conTetto('https://x.it', { signal: suo }, 1_000)!.signal).toBe(suo);
    });

    it('`signal: null` significa «nessuno», ed è proprio il caso in cui il tetto deve esserci', async () => {
        const { conTetto } = await import('@/lib/logging/tetto');
        expect(conTetto('https://x.it', { signal: null }, 1_000)!.signal).toBeInstanceOf(AbortSignal);
    });

    it('una `Request` come input NON si scavalca: il suo signal sparirebbe in silenzio', async () => {
        // Lo dice la specifica di `fetch`: se `init` porta un `signal`, quello della `Request`
        // non viene più usato. Sostituirlo significherebbe DISARMARE un annullamento che il
        // chiamante governa — e un annullamento disarmato non lo vede nessuno.
        const { conTetto } = await import('@/lib/logging/tetto');
        const req = new Request('https://x.it', { method: 'POST' });

        expect(conTetto(req, undefined, 1_000)).toBeUndefined();
    });

    it('FAIL-OPEN: se `AbortSignal.timeout` non esiste si perde il tetto, non la chiamata', async () => {
        const { conTetto } = await import('@/lib/logging/tetto');
        const originale = AbortSignal.timeout;
        AbortSignal.timeout = (() => {
            throw new TypeError('AbortSignal.timeout is not a function');
        }) as typeof AbortSignal.timeout;
        try {
            expect(conTetto('https://x.it', { method: 'POST' }, 1_000)).toEqual({ method: 'POST' });
        } finally {
            AbortSignal.timeout = originale;
        }
    });
});

describe('tettoSano — un valore assurdo non diventa «nessun tetto»', () => {
    it('un numero positivo e finito passa', async () => {
        const { tettoSano } = await import('@/lib/logging/tetto');
        expect(tettoSano(1_234, 9_000)).toBe(1_234);
    });

    it('`0`, i negativi, `NaN` e `Infinity` tornano al ripiego', async () => {
        // `0` e i negativi interromperebbero la chiamata PRIMA di farla; `NaN` e `Infinity`
        // danno un `AbortSignal.timeout` che non scatta mai — cioè di nuovo il difetto.
        const { tettoSano } = await import('@/lib/logging/tetto');
        for (const assurdo of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '5000']) {
            expect(tettoSano(assurdo, 9_000)).toBe(9_000);
        }
    });

    it('il `massimo` tosa il valore RICHIESTO: un\'ora chiesta da un chiamante non è un tetto', async () => {
        const { tettoSano } = await import('@/lib/logging/tetto');
        expect(tettoSano(3_600_000, 9_000, 30_000)).toBe(30_000);
        // e non tocca chi resta sotto: la valvola serve a stringere, e stringere si può sempre.
        expect(tettoSano(500, 9_000, 30_000)).toBe(500);
    });

    it('il `massimo` NON tosa il RIPIEGO, ed è deliberato: altrimenti nasconde la tabella', async () => {
        // Il ripiego è il valore della TABELLA (`TETTI_MS_PROVIDER`, `TETTI_MS_AREA`), e su
        // quello l'ancoraggio assoluto è un TEST che lo misura (§5 qui sotto). Tosarlo anche
        // qui renderebbe quel test verde per costruzione: si potrebbe scrivere
        // `['web-push', 600_000]` in tabella e la funzione restituirebbe comunque 30.000,
        // cioè una rete che NASCONDE il buco invece di segnalarlo. È il modo esatto in cui una
        // correzione ne introduce un'altra.
        const { tettoSano } = await import('@/lib/logging/tetto');
        expect(tettoSano(undefined, 600_000, 30_000)).toBe(600_000);
    });

    it('un `massimo` assurdo si ignora: meglio nessun limite che tutte le chiamate azzerate', async () => {
        const { tettoSano } = await import('@/lib/logging/tetto');
        for (const assurdo of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(tettoSano(5_000, 9_000, assurdo)).toBe(5_000);
        }
    });
});

describe('eTimeout / erroreTimeout — una scadenza non è una rete giù', () => {
    it('riconosce la scadenza di `AbortSignal.timeout` e NON un annullamento a mano', async () => {
        const { eTimeout } = await import('@/lib/logging/tetto');

        expect(eTimeout(new DOMException('scaduto', 'TimeoutError'))).toBe(true);
        // Un `abort()` chiesto a mano è un annullamento VOLUTO: spacciarlo per scadenza
        // manderebbe a cercare un provider lento che non c'è.
        expect(eTimeout(new DOMException('annullato', 'AbortError'))).toBe(false);
        expect(eTimeout(new Error('ECONNREFUSED'))).toBe(false);
        expect(eTimeout(null)).toBe(false);
    });

    it('l\'errore da loggare porta il codice, il nome e il NUMERO di millisecondi', async () => {
        const { erroreTimeout } = await import('@/lib/logging/tetto');
        const causa = new DOMException('scaduto', 'TimeoutError');

        const err = erroreTimeout('SupabaseTimeoutError', 'da Supabase', 250, causa);

        // `where codice = 'timeout'` conta i bersagli che non rispondono.
        expect((err as { code?: string }).code).toBe('timeout');
        // `get_runtime_errors` raggruppa per NOME: le scadenze nel loro secchio.
        expect(err.name).toBe('SupabaseTimeoutError');
        // Senza il numero non si distingue «è morto» da «il tetto è troppo stretto».
        expect(err.message).toContain('250');
        expect(err.message).toContain('da Supabase');
        // Non si butta via niente: il motivo di piattaforma resta come causa.
        expect(err.cause).toBe(causa);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. LE DUE STRADE, MISURATE SULLO STESSO SERVER MUTO.
 *
 * Il secondo test di questo blocco è IL difetto W7: prima della correzione non finiva —
 * la promise non si risolveva e vitest lo uccideva per scadenza propria.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Un server che ACCETTA la connessione e non risponde MAI: né header, né corpo, né chiusura. */
function serverMuto(): Promise<{ srv: Server; base: string }> {
    return new Promise((risolvi) => {
        const srv = createServer(() => {
            /* silenzio deliberato: è esattamente il bersaglio che manda in stallo la route */
        });
        srv.listen(0, '127.0.0.1', () => {
            const porta = (srv.address() as AddressInfo).port;
            risolvi({ srv, base: `http://127.0.0.1:${porta}` });
        });
    });
}

const TETTO_DI_PROVA = 250;

/**
 * L'attesa MISURATA sta ATTORNO al tetto — non «da qualche parte sotto i tre secondi».
 *
 * Il vincolo di prima era `Date.now() - t0 < 3_000` con un tetto di 250 ms: dodici volte il
 * valore atteso, cioè un'asserzione che un tetto sbagliato di un ORDINE DI GRANDEZZA non fa
 * diventare rossa. Misurato: sostituendo `AbortSignal.timeout(ms)` con `AbortSignal.timeout(ms
 * * 10)` dentro `conTetto`, ogni test di questo file restava verde — mentre in produzione i 15
 * secondi dell'auth sarebbero diventati 150, cioè il difetto di partenza tale e quale.
 *
 * Le due sponde servono tutte e due, e per ragioni opposte: quella di SOPRA dice che il tetto
 * non è più largo di ciò che dichiara (×10 → 2.500 ms, fuori); quella di SOTTO dice che non
 * taglia PRIMA (÷10 → 25 ms, fuori), il che romperebbe le chiamate lecite senza che nessuna
 * asserzione «minore di» se ne accorga mai. Il margine in su resta generoso — la misura include
 * la connessione TCP e il risveglio del worker sotto vitest — ma è PROPORZIONALE al tetto, non
 * un numero fisso: è la proporzione a rendere l'asserzione sensibile alla scala.
 */
function attesaAttornoAlTetto(ms: number): void {
    expect(ms, `interrotta troppo PRESTO: ${ms} ms per un tetto di ${TETTO_DI_PROVA} ms`)
        .toBeGreaterThanOrEqual(TETTO_DI_PROVA / 2);
    expect(ms, `interrotta troppo TARDI: ${ms} ms per un tetto di ${TETTO_DI_PROVA} ms`)
        .toBeLessThan(TETTO_DI_PROVA * 4);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL NUMERO CHE SI LOGGA E IL NUMERO CHE SI APPLICA SONO DUE GRANDEZZE DIVERSE.
 *
 * Oggi condividono una variabile — `tetto` — e per questo nessun test le distingueva: ogni
 * asserzione era un `toContain(String(TETTO_DI_PROVA))` sul messaggio, cioè leggeva la stessa
 * variabile da cui il messaggio nasce. Misurato: scollegandole con un `tetto * 10` dentro
 * `erroreTimeout(…)` / `abortDaScadenza(…)`, tutti e 83 i test restavano verdi. E `toContain`
 * per di più non ha delimitatori: «2500 ms» CONTIENE «250».
 *
 * Cosa costa in produzione, che è il motivo per cui non è un cavillo: `app_log.messaggio` e
 * l'errore consegnato al chiamante dichiarerebbero un tetto che non è quello scattato — cioè
 * manderebbero a cercare «il tetto è troppo stretto» quando è vero «il bersaglio è morto». È
 * ESATTAMENTE la distinzione per cui `erroreTimeout` esiste.
 *
 * Perciò da qui in poi le due grandezze si misurano SEPARATAMENTE: il numero APPLICATO si spia
 * su `AbortSignal.timeout` (`tettiChiesti`), il numero DICHIARATO si estrae dal testo
 * (`tettoDichiarato`), e si confrontano fra loro.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** I millisecondi CHIESTI ad `AbortSignal.timeout` durante `lavoro`: il tetto APPLICATO. */
async function tettiChiesti<T>(lavoro: () => Promise<T>): Promise<{ esito: T; chiesti: number[] }> {
    const originale = AbortSignal.timeout;
    const chiesti: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
        chiesti.push(ms);
        return originale.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
        return { esito: await lavoro(), chiesti };
    } finally {
        AbortSignal.timeout = originale;
    }
}

/**
 * Il numero DICHIARATO in un messaggio di scadenza — quello che leggerà chi apre `app_log`.
 * `null` quando il messaggio non ne porta nessuno, che è già di per sé un fallimento: senza il
 * numero non si distingue «è morto» da «il tetto è troppo stretto».
 */
function tettoDichiarato(testo: unknown): number | null {
    const m = /tetto di (\d+) ms/.exec(String(testo));
    return m === null ? null : Number(m[1]);
}

describe('nessuna delle due strade resta appesa', () => {
    let muto: { srv: Server; base: string };

    beforeEach(async () => {
        muto = await serverMuto();
    });

    afterEach(() => {
        // Anche se il test è caduto per scadenza: un server aperto tiene in vita il worker.
        muto.srv.closeAllConnections();
        muto.srv.close();
    });

    it('strada 1 — un PROVIDER esterno che accetta e tace viene interrotto entro il tetto', async () => {
        const { externalFetch } = await import('@/lib/logging/external');

        const t0 = Date.now();
        const { esito: r, chiesti } = await tettiChiesti(() =>
            externalFetch('resend', `${muto.base}/v1/invia`, { method: 'POST' },
                { timeoutMs: TETTO_DI_PROVA }));

        attesaAttornoAlTetto(Date.now() - t0);
        expect(r.ok).toBe(false);
        expect(r.stato).toBe(0);
        // IL NUMERO APPLICATO alla `fetch`, spiato sulla primitiva.
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        // IL NUMERO DICHIARATO al chiamante, letto dal testo — e devono essere LO STESSO. È il
        // confronto che mancava: prima si asseriva `toContain('250')` su un messaggio nato
        // dalla stessa variabile, quindi un `tetto * 10` passava indisturbato («2500» contiene
        // «250»), e in `app_log` il corpo dichiarava un tetto che non era quello scattato.
        expect(tettoDichiarato(r.corpo),
            `il corpo dichiara un tetto diverso da quello applicato: ${r.corpo}`)
            .toBe(chiesti[0]);
    });

    it('strada 2 — IL DIFETTO: un SUPABASE che accetta e tace viene interrotto entro il tetto', async () => {
        // Senza il tetto qui non ci si arriva mai: la promise non si risolve, e il test muore
        // per scadenza di vitest invece che con un esito. È il modo in cui la strada accanto
        // era rimasta scoperta senza che nessun test diventasse rosso — perché non c'era.
        const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch');
        const f = creaFetchStrumentato(undefined, { timeoutMs: TETTO_DI_PROVA });

        const t0 = Date.now();
        const { esito: errore, chiesti } = await tettiChiesti(() =>
            f(`${muto.base}/rest/v1/alunni?select=*`).then(
                () => new Error('la chiamata NON doveva riuscire'),
                (e: unknown) => e,
            ));

        attesaAttornoAlTetto(Date.now() - t0);
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        // Questo messaggio è ciò che postgrest-js consegna al codice applicativo dentro
        // `{ error }`: se dichiara un tetto 10× sbagliato, chi legge il guasto cerca dalla
        // parte opposta. Il numero DEVE essere quello davvero attaccato alla `fetch`.
        expect(tettoDichiarato((errore as Error).message),
            `l'errore rilanciato dichiara un tetto diverso da quello applicato: ${(errore as Error).message}`)
            .toBe(chiesti[0]);
    });

    it('e vale anche sull\'AUTH, che è il gate di ogni richiesta API', async () => {
        // `resolveIdentity()` chiama `auth.getUser()` a OGNI richiesta: se GoTrue accetta e tace,
        // senza tetto NESSUNA route dell'applicazione risponde più.
        const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch');
        const f = creaFetchStrumentato(undefined, { timeoutMs: TETTO_DI_PROVA });

        const t0 = Date.now();
        await f(`${muto.base}/auth/v1/user`).catch(() => {});

        attesaAttornoAlTetto(Date.now() - t0);
    });

    it('IL NOME DELL\'AREA governa la fetch VERA: la tabella non è un ornamento', async () => {
        // Tutti i test qui sopra passano `timeoutMs` ESPLICITO, quindi collaudano la valvola
        // del chiamante e nient'altro. Il percorso «nome dell'area → tetto davvero attaccato
        // alla chiamata» non lo guardava nessuno: sostituendo `tettoMsArea(b.area, …)` con un
        // `tettoSano(…)` qualsiasi dentro `creaFetchStrumentato`, la suite restava verde e la
        // tabella delle aree diventava decorativa — `storage`, che esiste per non troncare a
        // metà un upload da 10 MB, sarebbe tornato al default senza che niente lo dicesse.
        const { creaFetchStrumentato, tettoMsArea } = await import('@/lib/logging/supabase-fetch');
        const originale = AbortSignal.timeout;
        const chiesti: number[] = [];
        AbortSignal.timeout = ((ms: number) => {
            chiesti.push(ms);
            return originale.call(AbortSignal, ms);
        }) as typeof AbortSignal.timeout;
        try {
            // Niente rete: qui si misura il NUMERO, non l'attesa.
            const f = creaFetchStrumentato(async () => new Response('{}', { status: 200 }));
            await f('https://x.supabase.co/storage/v1/object/allegati/x.pdf');
            await f('https://x.supabase.co/rest/v1/alunni?select=id');
            await f('https://x.supabase.co/auth/v1/user');
        } finally {
            AbortSignal.timeout = originale;
        }

        expect(chiesti).toEqual([tettoMsArea('storage'), tettoMsArea('db'), tettoMsArea('auth')]);
        // CONTROLLO: i due numeri devono essere DIVERSI, altrimenti l'uguaglianza qui sopra
        // resterebbe vera anche con un tetto solo per tutte le aree — cioè non misurerebbe
        // niente. È la deroga di `storage` a doversi vedere.
        expect(tettoMsArea('storage')).not.toBe(tettoMsArea('db'));
    });

    /* ────────────────────────────────────────────────────────────────────────
     * Come degrada la strada Supabase: il chiamante è supabase-js, non noi.
     * ──────────────────────────────────────────────────────────────────────── */

    it('l\'errore rilanciato NON viene RITENTATO da postgrest-js (4 × il tetto sarebbe nessun tetto)', async () => {
        // postgrest-js ritenta da solo GET/HEAD/OPTIONS sugli errori di rete: 3 ritentativi con
        // backoff 1s/2s/4s. Su un errore che fallisce SUBITO (connessione rifiutata) costa il
        // solo backoff; su una SCADENZA costerebbe un tetto intero per tentativo — cioè
        // 4 × tetto + 7 s, che è tanto quanto non avere un tetto.
        //
        // L'unica scorciatoia che postgrest-js concede è questa, letta dal suo sorgente. Il
        // controllo è sul PACCHETTO VERO e non su una costante ricopiata: se un aggiornamento
        // cambia la politica di retry, questo test lo dice il giorno dell'aggiornamento invece
        // di lasciare che il tetto torni a valere un quarto di quel che dice.
        const dist = path.join(RADICE, 'node_modules/@supabase/postgrest-js/dist');
        const bundle = fs.readdirSync(dist).filter((f) => /^index\.(c|m)?js$/.test(f));
        expect(bundle.length, 'postgrest-js non ha più i bundle attesi').toBeGreaterThan(0);

        const regola = /===\s*["']AbortError["'][\s\S]{0,300}===\s*["']ABORT_ERR["']/;
        for (const f of bundle) {
            expect(regola.test(fs.readFileSync(path.join(dist, f), 'utf8')),
                `postgrest-js (${f}) ha cambiato la politica di retry: rileggere il ramo \`catch (fetchError)\``,
            ).toBe(true);
        }

        const { creaFetchStrumentato } = await import('@/lib/logging/supabase-fetch');
        const f = creaFetchStrumentato(undefined, { timeoutMs: TETTO_DI_PROVA });

        const e = await f(`${muto.base}/rest/v1/alunni`).then(() => null, (x: unknown) => x) as
            { name?: string; code?: string; cause?: unknown } | null;

        expect(e).not.toBeNull();
        expect(e!.name === 'AbortError' || e!.code === 'ABORT_ERR').toBe(true);
        // E non si è buttato via niente: il motivo di piattaforma resta come causa.
        expect((e!.cause as { name?: string } | undefined)?.name).toBe('TimeoutError');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. LA RIGA — una scadenza smette di essere un buco silenzioso.
 * ════════════════════════════════════════════════════════════════════════════ */

type Riga = Record<string, unknown>;

/** Ricarica il grafo con la guardia SILENZIOSO spenta e `app-log` MOCKATO (mai il DB vero). */
async function caricaRumoroso() {
    const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    const supabase = await import('@/lib/logging/supabase-fetch');
    return { ...supabase, appLog };
}

describe('la scadenza di Supabase è VISIBILE, con un codice suo', () => {
    let muto: { srv: Server; base: string };
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
        muto = await serverMuto();
    });

    afterEach(() => {
        muto.srv.closeAllConnections();
        muto.srv.close();
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    function scritto(): string {
        return [...log.mock.calls, ...err.mock.calls]
            .flat()
            .map((a) => (typeof a === 'string' ? a : String((a as Error)?.message ?? a)))
            .join('\n');
    }

    it('la riga su Vercel porta `code=timeout`, non un errore di rete generico', async () => {
        const { creaFetchStrumentato } = await caricaRumoroso();
        const f = creaFetchStrumentato(undefined, { timeoutMs: TETTO_DI_PROVA });

        const { chiesti } = await tettiChiesti(() =>
            f(`${muto.base}/rest/v1/alunni`).catch(() => {}));

        const righe = scritto();
        // `KV_ERR` è il livello: una scadenza NON è un annullamento chiesto dal chiamante, e
        // resta `error`. In questo ramo girano DUE errori simili — quello che si LOGGA
        // (`code: 'timeout'`) e quello che si RILANCIA a postgrest-js (`code: 'ABORT_ERR'`, che
        // serve a disinnescarne il retry). Scambiarli è una riga sola, e la riga di log
        // scivolerebbe a `info` in silenzio: è per quello che la guardia `!scaduto` resta.
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('code=timeout');
        expect(righe).not.toContain('ABORT_ERR');
        // «non risponde» si ripara alzando il tetto o chiamando il fornitore, «non si raggiunge»
        // si ripara sul DNS o sul firewall: con un codice solo sarebbero indistinguibili. E il
        // NUMERO sulla riga dev'essere quello davvero applicato: un `toContain('250')` restava
        // verde su una riga che dichiarava 2500 ms, cioè su una riga che mente a chi la legge.
        expect(chiesti).toEqual([TETTO_DI_PROVA]);
        expect(tettoDichiarato(righe), `la riga dichiara un tetto diverso da quello applicato:\n${righe}`)
            .toBe(chiesti[0]);
    });

    it('e NON si scrive in tabella: se Supabase non risponde, non risponde nemmeno per il log', async () => {
        const { creaFetchStrumentato, appLog } = await caricaRumoroso();
        const f = creaFetchStrumentato(undefined, { timeoutMs: TETTO_DI_PROVA });

        await f(`${muto.base}/rest/v1/alunni`).catch(() => {});
        await new Promise((r) => setTimeout(r, 5));

        expect(appLog).not.toHaveBeenCalled();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. ANCORAGGIO ASSOLUTO — un tetto di mezz'ora è funzionalmente nessun tetto.
 *
 * I test delle due tabelle pinnano l'ORDINE relativo (instagram < default < aruba): moltiplicando
 * ogni valore per 60 l'ordine regge e la suite resta verde, mentre in produzione il difetto
 * tornerebbe intero — a tagliare sarebbe di nuovo la piattaforma. Serve un LIMITE SUPERIORE, e
 * deve essere qui, non nella testa di chi rilegge la tabella.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('i tetti stanno dentro un numero sensato', () => {
    /** Il taglio di piattaforma resta il limite esterno: un tetto più alto non scatta mai. */
    const MAI_OLTRE_MS = 30_000;
    /** Su Supabase la deroga più larga è `storage`, e da lì non si sale. */
    const MAI_OLTRE_MS_AREA = 20_000;

    it('nessun provider esterno aspetta più di 30 secondi — e si scorre la TABELLA, non una lista', async () => {
        // L'elenco dei nomi era CABLATO qui dentro: `['resend','fcm','sidi','instagram',
        // 'aruba','provider-mai-visto']`. Misurato: aggiungendo `['web-push', 600_000]` a
        // `TETTI_MS_PROVIDER` restava tutto verde, perché il nome nuovo nel test non c'era —
        // l'ancoraggio copriva i provider di IERI. Adesso l'elenco È la tabella: una deroga
        // entra nel lock il giorno stesso in cui qualcuno la scrive.
        const { tettoMs, TETTI_MS_PROVIDER } = await import('@/lib/logging/external');

        expect(TETTI_MS_PROVIDER.size,
            'la tabella delle deroghe è vuota: questo lock non misurerebbe più niente')
            .toBeGreaterThan(0);

        for (const p of [...TETTI_MS_PROVIDER.keys(), 'resend', 'fcm', 'sidi', 'provider-mai-visto']) {
            expect(tettoMs(p), `il tetto di ${p} è fuori scala`).toBeLessThanOrEqual(MAI_OLTRE_MS);
            expect(tettoMs(p), `il tetto di ${p} non è un tetto`).toBeGreaterThan(0);
        }

        // CONTROLLO — senza `richiesto`, `tettoMs` restituisce il valore GREZZO della tabella.
        // Se un giorno tosasse anche quello, le asserzioni qui sopra diventerebbero vere per
        // costruzione e il lock smetterebbe di vedere una tabella che cresce: sarebbe una rete
        // che nasconde il buco invece di segnalarlo.
        for (const [p, ms] of TETTI_MS_PROVIDER) expect(tettoMs(p), `${p} non legge la tabella`).toBe(ms);
    });

    it('nessuna area di Supabase aspetta più di 20 secondi — e si scorre la TABELLA', async () => {
        const { tettoMsArea, TETTI_MS_AREA } = await import('@/lib/logging/supabase-fetch');

        expect(TETTI_MS_AREA.size,
            'la tabella delle deroghe è vuota: questo lock non misurerebbe più niente')
            .toBeGreaterThan(0);

        for (const a of [...TETTI_MS_AREA.keys(), 'db', 'rpc', 'storage', 'auth', 'altro']) {
            expect(tettoMsArea(a), `il tetto di ${a} è fuori scala`).toBeLessThanOrEqual(MAI_OLTRE_MS_AREA);
            expect(tettoMsArea(a), `il tetto di ${a} non è un tetto`).toBeGreaterThan(0);
        }

        for (const [a, ms] of TETTI_MS_AREA) expect(tettoMsArea(a), `${a} non legge la tabella`).toBe(ms);
    });

    it('nemmeno un chiamante può chiedere un tetto smisurato… ma può chiederne uno più stretto', async () => {
        const { tettoMs } = await import('@/lib/logging/external');
        const { tettoMsArea } = await import('@/lib/logging/supabase-fetch');

        // LA PRIMA METÀ DEL NOME ERA FALSA, e per mezza giornata questo test l'ha dichiarata
        // senza asserirla: `tettoMs('resend', 3_600_000)` restituiva 3.600.000: la valvola del
        // chiamante scavalcava l'intero ancoraggio, e chi leggeva il titolo del test smetteva
        // di cercare l'invariante altrove. Adesso c'è, e sta nel codice (`TETTO_MS_MAX`).
        expect(tettoMs('resend', 3_600_000)).toBeLessThanOrEqual(MAI_OLTRE_MS);
        expect(tettoMsArea('db', 3_600_000)).toBeLessThanOrEqual(MAI_OLTRE_MS_AREA);
        // E nemmeno di poco sopra: il limite è il limite, anche per il provider più lento.
        expect(tettoMs('aruba', 45_000)).toBeLessThanOrEqual(MAI_OLTRE_MS);
        expect(tettoMsArea('storage', 45_000)).toBeLessThanOrEqual(MAI_OLTRE_MS_AREA);

        // La valvola serve a STRINGERE (una chiamata sincrona con un operatore davanti), e
        // stringere si può sempre: il massimo è un tetto, non una taratura.
        expect(tettoMs('resend', 500)).toBe(500);
        expect(tettoMsArea('db', 500)).toBe(500);
        expect(tettoMs('aruba', 1_000)).toBe(1_000);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. SULLA STRADA AUTH IL TETTO È DI UN TENTATIVO, NON DELLA CHIAMATA.
 *
 * `@supabase/auth-js` avvolge QUALUNQUE eccezione del fetch — la nostra scadenza compresa — in
 * un `AuthRetryableFetchError`, e `_refreshAccessToken` ritenta finché il tempo trascorso più
 * il prossimo backoff sta sotto `AUTO_REFRESH_TICK_DURATION_MS`. Con un tetto di 15 secondi
 * fanno DUE tentativi, cioè il DOPPIO del tetto: il commento di `supabase-fetch.ts` dichiarava
 * 15 secondi e la strada auth ne spendeva il doppio, senza che niente lo dicesse.
 *
 * Qui non si collauda la libreria: si tiene onesto il NUMERO SCRITTO in quel commento. Un
 * commento che dichiara un tetto che il sistema non rispetta è la stessa classe di difetto dei
 * test finti — dice una cosa, il sistema ne fa un'altra, e chi legge smette di cercare.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il tetto dell\'auth è per TENTATIVO: il commento deve dire il numero vero', () => {
    const AUTH_JS = path.join(RADICE, 'node_modules/@supabase/auth-js/dist/main');

    function fonte(rel: string): string {
        return fs.readFileSync(path.join(AUTH_JS, rel), 'utf8');
    }

    /**
     * Il caso peggiore, calcolato con la stessa aritmetica della libreria:
     * ogni tentativo scade AL TETTO, prima del successivo si dorme `200·2^(n-1)`, e si ritenta
     * solo se `trascorso + prossimo backoff < tick`.
     */
    function peggioreAuth(tetto: number, tick: number): { tentativi: number; ms: number } {
        let trascorso = 0;
        for (let n = 1; n <= 100; n++) {
            trascorso += tetto;
            const prossimo = 200 * 2 ** (n - 1);
            if (trascorso + prossimo >= tick) return { tentativi: n, ms: trascorso };
            trascorso += prossimo;
        }
        throw new Error('il ciclo di ritentativi non converge: rileggere la politica di auth-js');
    }

    /**
     * Il SOLO blocco di commento che parla dell'auth, ritagliato fra `⚠️ SULL'AUTH` e la
     * dichiarazione di `TETTO_MS_DEFAULT` che quel blocco documenta, e normalizzato a una riga.
     *
     * Il perimetro è la metà della correzione: la regola di prima girava sul FILE INTERO, e un
     * lock che si accende su un «~N s» innocuo scritto duecento righe più in là non viene
     * corretto — viene tolto.
     */
    function bloccoAuth(): string {
        const src = sorgente('supabase-fetch.ts');
        const inizio = src.indexOf('⚠️ SULL\'AUTH');
        if (inizio < 0) return '';
        const fine = src.indexOf('const TETTO_MS_DEFAULT', inizio);
        if (fine < 0) return '';
        return src.slice(inizio, fine).replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');
    }

    /**
     * Le frasi che dichiarano un TOTALE dell'accesso, e il numero di secondi che dichiarano.
     *
     * Le frasi si delimitano su `.` e `;` — che spezza anche `Date.now()` e `15.000`, e va
     * benissimo: ciò che conta è che un marcatore di totale e un numero di secondi finiscano
     * nello stesso frammento solo quando sono davvero nella stessa affermazione.
     *
     * Le grafie coperte sono tutte quelle che un essere umano scrive: «~30,2 s», «30.2 s»,
     * «30 sec», «circa 15 secondi». Quella di prima ne vedeva una sola.
     */
    function totaliDichiarati(blocco: string): Array<{ testo: string; secondi: number }> {
        const TOTALE = /complessiv|in tutto|in totale|nel complesso|caso peggiore/i;
        const SECONDI = /\b(\d+(?:[.,]\d+)?)\s*(?:s|sec|secondi)\b/gi;
        const fuori: Array<{ testo: string; secondi: number }> = [];
        for (const frase of blocco.split(/[.;]/)) {
            if (!TOTALE.test(frase)) continue;
            for (const m of frase.matchAll(SECONDI)) {
                fuori.push({ testo: frase.trim(), secondi: Number(m[1].replace(',', '.')) });
            }
        }
        return fuori;
    }

    it('auth-js ritenta ANCHE la nostra scadenza, e la politica è quella che crediamo', () => {
        // Il controllo è sul PACCHETTO VERO, non su costanti ricopiate: se un aggiornamento
        // cambia la politica, lo si scopre il giorno dell'aggiornamento invece di lasciare in
        // giro un commento che è diventato falso.
        expect(fonte('lib/fetch.js'),
            'auth-js non avvolge più ogni eccezione in AuthRetryableFetchError: rileggere handleError()')
            .toMatch(/looksLikeFetchResponse\)\(error\)\)[\s\S]{0,120}AuthRetryableFetchError/);
        expect(fonte('lib/constants.js'),
            'AUTO_REFRESH_TICK_DURATION_MS non è più 30 s: il conto nel commento va rifatto')
            .toMatch(/AUTO_REFRESH_TICK_DURATION_MS\s*=\s*30\s*\*\s*1000/);
        expect(fonte('GoTrueClient.js'),
            'il backoff di _refreshAccessToken non è più 200·2^n')
            .toMatch(/nextBackOffInterval\s*=\s*200\s*\*\s*Math\.pow\(2,\s*attempt\)/);
        expect(fonte('GoTrueClient.js'),
            'la condizione di ritentabilità non è più «trascorso + backoff < tick»')
            .toMatch(/Date\.now\(\)\s*\+\s*nextBackOffInterval\s*-\s*startedAt\s*<\s*constants_1\.AUTO_REFRESH_TICK_DURATION_MS/);
    });

    it('IL NUMERO NEL COMMENTO è quello che l\'aritmetica produce, non il tetto di un tentativo', async () => {
        const { tettoMsArea } = await import('@/lib/logging/supabase-fetch');
        const { tentativi, ms } = peggioreAuth(tettoMsArea('auth'), 30_000);

        // Due tentativi, cioè il DOPPIO del tetto dichiarato: è il fatto da cui nasce tutto il
        // resto di questo blocco.
        expect(tentativi).toBeGreaterThan(1);
        expect(ms).toBeGreaterThan(tettoMsArea('auth') * 2);

        // E IL COMMENTO LO DEVE DIRE — tutte le volte che lo dice.
        //
        // ─────────────────────────────────────────────────────────────────────────────
        // COM'ERA, E PERCHÉ NON BASTAVA. La regola era `/~\d+(?:,\d+)? s\b/g` su TUTTO il file.
        // Sbagliata in tutte e due le direzioni:
        //
        //  · TROPPO STRETTA sulla grafia. Vedeva solo «~30,2 s». Aggiungendo «il tetto
        //    complessivo dell'accesso resta di circa 15 secondi» il file si contraddiceva da
        //    solo e il test restava verde — cioè il lock non copriva il modo più naturale di
        //    scrivere la stessa frase sbagliata.
        //  · TROPPO LARGA sul perimetro. Qualunque «~N s» legittimo scritto ALTROVE in
        //    `supabase-fetch.ts` lo faceva diventare rosso. Un lock che si accende sui commenti
        //    innocenti non viene corretto: viene indebolito, e allora tanto vale non averlo.
        //
        // COM'È ADESSO. Si ritaglia il SOLO blocco che parla dell'auth (fra `⚠️ SULL'AUTH` e
        // `const TETTO_MS_DEFAULT`), e dentro quel blocco si guardano soltanto le frasi che
        // dichiarano un TOTALE — «caso peggiore», «in tutto», «complessivo». Sono quelle, e
        // solo quelle, che il sistema deve rispettare. Gli altri numeri di secondi che il
        // blocco cita — il tetto di UN tentativo (15 s), il dimezzamento ipotetico (7,5 s),
        // l'accesso lento ma vero misurato (12 s), il limite d'area (20 secondi) — sono fatti
        // veri e diversi, e un lock che li pretendesse tutti uguali sarebbe soltanto rumore.
        // ─────────────────────────────────────────────────────────────────────────────
        const blocco = bloccoAuth();
        // Autoinganno: se i due delimitatori cambiassero, il ritaglio sarebbe vuoto e ogni
        // regola qui sotto passerebbe senza aver letto niente.
        expect(blocco.length,
            'il blocco ⚠️ SULL\'AUTH di `supabase-fetch.ts` non si ritaglia più: rileggere i delimitatori')
            .toBeGreaterThan(400);

        const attesoS = ms / 1_000;
        const dichiarati = totaliDichiarati(blocco);

        expect(dichiarati,
            `il commento non dichiara nessun caso peggiore: dovrebbe dire ~${attesoS.toFixed(1).replace('.', ',')} s `
            + `(${tentativi} tentativi)`)
            .not.toHaveLength(0);
        for (const d of dichiarati) {
            expect(d.secondi,
                `il caso peggiore vero è ${attesoS} s in ${tentativi} tentativi, il commento dichiara «${d.testo}»`)
                .toBe(attesoS);
        }
    });
});
