import { redigiPathNelTesto } from './path';

/**
 * Serializzazione difensiva per il logger.
 *
 * Regola d'oro: NIENTE qui dentro può lanciare. Un throw nel logger trasforma
 * una risposta 200 in un 500 su TUTTE le route. Meglio un log incompleto che
 * un'app rotta dall'osservabilità.
 *
 * ⚠️ L'UNICO IMPORT AMMESSO È `./path`, e solo perché `path.ts` a sua volta non importa NULLA.
 * Questo modulo entra nel bundle dell'EDGE (`instrumentation.ts` lo importa staticamente, e Next
 * lo compila anche per il middleware): un import di `node:*` — `./redact`, che apre con
 * `node:crypto`, per dirne uno — non farebbe cadere un log, farebbe cadere la BUILD, e cadrebbe
 * sul middleware, cioè su ogni richiesta. Chi aggiunge un import qui verifichi prima la testata
 * di `path.ts`.
 */

const DIMENSIONE_MAX = 3_500; // Vercel tronca le righe lunghe: sotto la soglia
const DUMP_MAX = 300; // dump di un oggetto-errore senza `message`: è un ripiego, sta stretto
const STACK_MAX = 2_000; // uno stack non può da solo saturare il budget della riga
const FRAME_MAX = 10;
const MESSAGGIO_MAX = 500;
const PRE_TAGLIO = MESSAGGIO_MAX * 4; // vedi sanificaMessaggio: le regex non girano su un megabyte

/**
 * Rende stringa qualunque valore, senza mai lanciare.
 *
 * `JSON.stringify` lancia su un ciclo e su un BigInt: entrambi arrivano davvero
 * (un client Supabase è pieno di riferimenti circolari, un `count` da Postgres
 * può essere un bigint). Qui il replacer li neutralizza prima che stringify li veda,
 * e ciò che resta è comunque avvolto in un try.
 */
export function serializza(v: unknown, max: number = DIMENSIONE_MAX): string {
    let s: string;
    try {
        // Traccia gli ANTENATI (il percorso), non tutti gli oggetti già visti: con un
        // WeakSet globale un riferimento semplicemente CONDIVISO (`{ a: x, b: x }`, non
        // ciclico) risulterebbe `[ciclo]` e il dato sparirebbe dal log. `this`, dentro un
        // replacer, è l'oggetto che contiene il valore: risalendo di lì si sa quando la
        // ricorsione è tornata indietro. (Serve una `function`: una arrow non ha `this`.)
        const antenati: object[] = [];
        s = JSON.stringify(v, function (this: unknown, _k: string, val: unknown) {
            if (typeof val === 'bigint') return `${val.toString()}n`;
            if (typeof val === 'symbol' || typeof val === 'function') return `[${typeof val}]`;
            if (val === null || typeof val !== 'object') return val;

            while (antenati.length > 0 && antenati[antenati.length - 1] !== this) antenati.pop();
            if (antenati.indexOf(val as object) !== -1) return '[ciclo]';
            antenati.push(val as object);
            return val;
        }) ?? String(v); // `undefined` al vertice è l'unico caso: symbol e function li cattura il replacer
    } catch {
        // Ci si arriva con un getter che lancia, un toJSON rotto, un Proxy ostile.
        try {
            s = String(v);
        } catch {
            // `String()` lancia su un oggetto senza prototipo o con un Symbol.toPrimitive rotto.
            s = '[non-serializzabile]';
        }
    }
    return tronca(s, max);
}

/** Tronca a `max` caratteri, segnalando il taglio. Il risultato non supera MAI `max`. */
function tronca(s: string, max: number): string {
    if (s.length <= max) return s;
    if (max <= 1) return s.slice(0, Math.max(0, max)); // niente spazio nemmeno per l'ellissi
    return s.slice(0, max - 1) + '…';
}

export interface ErroreDescritto {
    messaggio: string;
    stack?: string;
    codice?: string;
    digest?: string;
    /** `details` di PostgREST: è QUI che arriva il `DETAIL: Key (…)=(…)` di Postgres. */
    dettagli?: string;
    /** `hint` di PostgREST. */
    suggerimento?: string;
    /** `cause` (ES2022), seguita per un solo livello: è dove si nasconde l'errore vero. */
    causa?: ErroreDescritto;
}

/**
 * Il pattern con cui Postgres riporta OGNI violazione di vincolo, e con cui i valori
 * finiscono dentro il testo dell'errore:
 *
 *   duplicate key value violates unique constraint "parents_email_key"
 *   DETAIL: Key (email)=(mario.rossi@example.com) already exists.
 *
 * Si maschera il valore, non la colonna: sapere QUALE vincolo è saltato è tutto ciò che
 * serve a diagnosticare; sapere su quale email è saltato non serve a nulla.
 * Il valore è preso GREEDY fino all'ultima `)` seguita da spazio o fine riga, perché può
 * contenerne una: `Key (indirizzo)=(Via Roma 1 (int. 3), Napoli) already exists.` Con un
 * match pigro la coda («, Napoli») resterebbe in chiaro.
 */
const VINCOLO_PG = /Key \(([^)]*)\)=\(.*\)(?=\s|$)/gm;
/**
 * La parte locale di un'email può contenere lettere accentate (`maría.rossì@…`): con una
 * classe ASCII il match si spezzerebbe a metà, lasciando in chiaro il resto.
 */
const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/**
 * Codice fiscale: 6 lettere, 2 cifre, 1 lettera, 2 cifre, 1 lettera, 3 cifre, 1 lettera.
 * Le posizioni numeriche accettano anche le lettere dell'OMOCODIA (L M N P Q R S T U V):
 * l'Agenzia delle Entrate le sostituisce alle cifre quando due codici collidono, e
 * `RSSMRA85T1LA562S` è un codice fiscale a tutti gli effetti.
 */
const OMOCODIA = '[\\dLMNPQRSTUVlmnpqrstuv]';
const CODICE_FISCALE = new RegExp(
    `\\b[A-Za-z]{6}${OMOCODIA}{2}[A-Za-z]${OMOCODIA}{2}[A-Za-z]${OMOCODIA}{3}[A-Za-z]\\b`,
    'g',
);

/**
 * Maschera i dati personali INCORPORATI nel testo di un errore.
 *
 * Perché esiste: `redact()` è a lista bianca PER CHIAVE, ma il testo di un errore non ha
 * chiavi — è testo libero. Senza questo passaggio l'email di un genitore entrerebbe nei
 * log di Vercel e in `app_log` scavalcando dal basso tutto l'apparato di redazione.
 *
 * È difesa in profondità, NON il presidio principale: sono euristiche sui valori, e le
 * euristiche danno falsi negativi (un cognome nudo in un messaggio non lo prende nessuno).
 * Qui però non c'è una chiave su cui applicare la lista bianca: è il meglio disponibile.
 * Il presidio vero resta `redact()` sui campi strutturati.
 *
 * Il telefono NON ha una maschera propria. Non perché «tanto arriva dentro
 * `Key (telefono)=(…)`» — arriva anche in `details`, ed esistono messaggi scritti a mano —
 * ma perché un regex su sequenze di cifre mangerebbe id, conteggi, codici d'errore e
 * timestamp, cioè proprio ciò che rende leggibile un log. Si accetta il falso negativo in
 * cambio di log che restano diagnostici.
 */
export function sanificaMessaggio(msg: string): string {
    try {
        // Pre-taglio PRIMA delle regex: quella dell'email fa backtracking, e un messaggio da
        // megabyte (un dump, l'HTML d'errore di un provider) la farebbe girare su tutto.
        // La soglia è larga: ciò che il taglio finale scarterà era comunque destinato al cestino.
        const mascherato = tronca(String(msg), PRE_TAGLIO)
            .replace(VINCOLO_PG, 'Key ($1)=(…)')
            .replace(EMAIL, '[email]')
            .replace(CODICE_FISCALE, '[cf]');
        // Si maschera PRIMA e si tronca DOPO: al contrario, un taglio a metà di un'email ne
        // lascerebbe in chiaro il primo pezzo, che è quello con nome e cognome.
        return tronca(mascherato, MESSAGGIO_MAX);
    } catch {
        return '[messaggio-illeggibile]';
    }
}

/** Legge un campo che può lanciare (getter ostile, `toString` rotto): si perde il campo, non l'errore. */
function sicuro<T>(leggi: () => T, fallback: T): T {
    try {
        return leggi();
    } catch {
        return fallback;
    }
}

/** Un frame di stack: `    at qualcosa (file:riga:colonna)`. */
const FRAME = /^\s*at\s/;

/**
 * Lo stack di V8 è `Name: message` seguito dai frame. L'HEADER NON È UN FRAME: È IL
 * MESSAGGIO. Quindi `new Error(messaggio_postgres).stack` si porta dentro l'email, e
 * sanificare il solo campo `messaggio` sarebbe decorativo.
 *
 * Perciò: header sanificato, frame intatti. I frame sono path di sorgenti e nomi di
 * funzione, non contengono dati personali, e sanificarli renderebbe il logger inutile
 * proprio nel momento in cui serve.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * L'HEADER PASSA ANCHE DA `redigiPathNelTesto`, E QUESTO È IL COLLO DI BOTTIGLIA.
 *
 * `sanificaMessaggio` maschera email, codici fiscali e vincoli Postgres — NON i path. Ma in
 * questo repo IL PATH È UNA CREDENZIALE: il token del modulo pubblico è un SEGMENTO di path
 * (`/m/<token>`), non un query param, ed è una capability riusabile che apre il modulo di
 * preiscrizione di un MINORE. E l'header dello stack È il messaggio: un
 * `new Error('Errore caricando https://app.kidville.it/m/<token>')` — cioè un banalissimo
 * errore di rete del browser — versava quel token in `app_log.stack`, dove vive 30 giorni e si
 * interroga in SQL.
 *
 * La riduzione va QUI e non nei chiamanti perché questo è l'UNICO punto da cui passa OGNI stack
 * del sistema: quelli del server (`logErrore`/`logEvento` → `descriviErrore`) e quelli del
 * CLIENT (`/api/logs` fa passare da `descriviErrore` anche lo stack che arriva dal browser).
 * `messaggio` e `route` la loro riduzione ce l'avevano già; lo stack era l'unico campo scoperto,
 * ed era anche l'unico che nessuna difesa a valle avrebbe ripreso.
 *
 * SOLO L'HEADER, MAI I FRAME, e non è prudenza: un frame è
 * `at f (/_next/static/chunks/layout-1a2b3c4d5e6f.js:1:2)`, e l'euristica del segmento opaco
 * (≥16 caratteri con una cifra) lo ridurrebbe a `[tok]` — cancellando la posizione dell'errore,
 * cioè l'unica cosa per cui uno stack esiste. I frame non contengono dati personali; l'header sì.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Si contano i FRAME, non le righe: un messaggio Postgres occupa 2+ righe di header, e a
 * contare righe si mangerebbe il budget dei frame. E c'è un cap in caratteri, perché
 * `new Error('x'.repeat(20_000))` produce uno stack da 20 KB in un modulo che esiste per
 * stare sotto i 3.500.
 */
function preparaStack(stack: string): string {
    const righe = stack.split('\n');
    const primoFrame = righe.findIndex((r) => FRAME.test(r));
    const testa = primoFrame === -1 ? righe : righe.slice(0, primoFrame);
    const frame = primoFrame === -1
        ? []
        : righe.slice(primoFrame).filter((r) => FRAME.test(r)).slice(0, FRAME_MAX);

    // `sanificaMessaggio` PRIMA (tronca a 500: ciò che taglia è buttato, non esposto), la
    // riduzione dei path DOPO, sul testo che sopravvive. Le due sono indipendenti — nessuna
    // maschera introdotta dall'una assomiglia a un path per l'altra — e `redigiPathNelTesto` è
    // fail-CLOSED: se non riesce a ridurre, restituisce `[testo-illeggibile]` invece di lasciar
    // passare un header di cui non può garantire che sia privo di credenziali.
    const header = redigiPathNelTesto(sanificaMessaggio(testa.join('\n')));
    return tronca([header, ...frame].join('\n'), STACK_MAX);
}

/** Testo di un campo d'errore (`details`, `hint`): sempre sanificato, mai grezzo. */
function testoSanificato(v: unknown): string | undefined {
    if (v === null || v === undefined) return undefined;
    return sanificaMessaggio(typeof v === 'string' ? v : serializza(v, DUMP_MAX));
}

const CAUSA_PROFONDITA_MAX = 1;

/**
 * Normalizza qualunque cosa sia stata lanciata: Error, oggetti PostgREST
 * (`{ code, message, details, hint }`), stringhe, `null`.
 *
 * Ogni campo è letto dentro il PROPRIO try: con un getter ostile si perde QUEL campo, non
 * l'errore intero — un `message` perfettamente leggibile non deve sparire perché `stack`
 * lanciava. Stessa disciplina di `redact.ts`.
 */
export function descriviErrore(err: unknown): ErroreDescritto {
    return descrivi(err, 0);
}

function descrivi(err: unknown, prof: number): ErroreDescritto {
    const eErrore = sicuro(() => err instanceof Error, false);

    // Primitivi (una stringa lanciata, null, undefined, un numero): niente campi da leggere.
    if (!eErrore && (err === null || typeof err !== 'object')) {
        return { messaggio: sicuro(() => sanificaMessaggio(String(err)), '[errore-illeggibile]') };
    }

    const o = err as Record<string, unknown>;

    const out: ErroreDescritto = {
        messaggio: sicuro(() => {
            const m = o.message;
            if (typeof m === 'string' && m !== '') return sanificaMessaggio(m);
            if (eErrore) return sanificaMessaggio(String(o.name ?? 'Error'));
            // Oggetto senza `message`: meglio un dump corto che un errore muto.
            return sanificaMessaggio(serializza(o, DUMP_MAX));
        }, '[campo-illeggibile]'),
    };

    const stack = sicuro(
        () => (typeof o.stack === 'string' ? preparaStack(o.stack) : undefined),
        '[campo-illeggibile]',
    );
    if (stack !== undefined) out.stack = stack;

    const codice = sicuro(() => (o.code === undefined ? undefined : String(o.code)), '[campo-illeggibile]');
    if (codice !== undefined) out.codice = codice;

    const digest = sicuro(() => (o.digest === undefined ? undefined : String(o.digest)), '[campo-illeggibile]');
    if (digest !== undefined) out.digest = digest;

    const dettagli = sicuro(() => testoSanificato(o.details), '[campo-illeggibile]');
    if (dettagli !== undefined) out.dettagli = dettagli;

    const suggerimento = sicuro(() => testoSanificato(o.hint), '[campo-illeggibile]');
    if (suggerimento !== undefined) out.suggerimento = suggerimento;

    // `new Error('salvataggio fallito', { cause: erroreSupabase })`: la causa È l'errore vero.
    // Un solo livello: basta a non perdere il colpevole, e non insegue una catena ciclica.
    if (prof < CAUSA_PROFONDITA_MAX) {
        const causa = sicuro(
            () => (o.cause === null || o.cause === undefined ? undefined : descrivi(o.cause, prof + 1)),
            { messaggio: '[campo-illeggibile]' } as ErroreDescritto,
        );
        if (causa !== undefined) out.causa = causa;
    }

    return out;
}
