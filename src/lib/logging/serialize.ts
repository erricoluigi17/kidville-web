/**
 * Serializzazione difensiva per il logger.
 *
 * Regola d'oro: NIENTE qui dentro può lanciare. Un throw nel logger trasforma
 * una risposta 200 in un 500 su TUTTE le route. Meglio un log incompleto che
 * un'app rotta dall'osservabilità.
 */

const DIMENSIONE_MAX = 3_500; // Vercel tronca le righe lunghe: sotto la soglia
const FRAME_MAX = 10;
const MESSAGGIO_MAX = 500;

/**
 * Rende una stringa qualunque valore, senza mai lanciare.
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
        }) ?? String(v); // stringify rende `undefined` su undefined/symbol/function al vertice
    } catch {
        // Ci si arriva con un getter che lancia, un toJSON rotto, un Proxy ostile.
        try {
            s = String(v);
        } catch {
            // `String()` lancia su un oggetto senza prototipo o con un Symbol.toPrimitive rotto.
            return '[non-serializzabile]';
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
}

/**
 * Il pattern con cui Postgres riporta OGNI violazione di vincolo, e con cui i valori
 * finiscono dentro il messaggio d'errore:
 *
 *   duplicate key value violates unique constraint "parents_email_key"
 *   DETAIL: Key (email)=(mario.rossi@example.com) already exists.
 *
 * Si maschera il valore, non la colonna: sapere QUALE vincolo è saltato è tutto ciò
 * che serve a diagnosticare; sapere su quale email è saltato non serve a nulla.
 * Se il valore contenesse una `)` il match si chiude in anticipo — il residuo passa
 * comunque sotto le due maschere seguenti, che sono l'ultima rete.
 */
const VINCOLO_PG = /Key \(([^)]*)\)=\([^)]*\)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Codice fiscale in forma canonica: 6 lettere, 2 cifre, 1 lettera, 2 cifre, 1 lettera, 3 cifre, 1 lettera. */
const CODICE_FISCALE = /\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]\b/g;

/**
 * Maschera i dati personali INCORPORATI nel testo di un messaggio d'errore.
 *
 * Perché esiste: `redact()` è a lista bianca PER CHIAVE, ma un messaggio d'errore non ha
 * chiavi — è testo libero. Senza questo passaggio l'email di un genitore entrerebbe nei
 * log di Vercel e in `app_log` scavalcando dal basso tutto l'apparato di redazione.
 *
 * È difesa in profondità, NON il presidio principale: sono euristiche sui valori, e le
 * euristiche danno falsi negativi (un cognome nudo in un messaggio non lo prende nessuno).
 * Qui però non c'è una chiave su cui applicare la lista bianca: è il meglio disponibile.
 * Il presidio vero resta `redact()` sui campi strutturati.
 *
 * Il telefono NON ha una maschera propria: un regex su sequenze di cifre mangerebbe id,
 * conteggi, codici d'errore e timestamp, cioè proprio ciò che rende leggibile un log.
 * Nei fatti il telefono arriva dentro `Key (telefono)=(…)`, e lì è già coperto.
 */
export function sanificaMessaggio(msg: string): string {
    try {
        const mascherato = String(msg)
            .replace(VINCOLO_PG, 'Key ($1)=(…)')
            .replace(EMAIL, '[email]')
            .replace(CODICE_FISCALE, '[cf]');
        // Si maschera PRIMA e si tronca DOPO: al contrario, un taglio a metà di un'email
        // ne lascerebbe in chiaro il primo pezzo, che è quello con nome e cognome.
        return tronca(mascherato, MESSAGGIO_MAX);
    } catch {
        return '[messaggio-illeggibile]';
    }
}

/**
 * Normalizza qualunque cosa sia stata lanciata. Accetta Error, stringhe, oggetti
 * PostgREST (`{ code, message }`) e `null`.
 *
 * Lo STACK esce in chiaro, ed è voluto: i frame sono path di sorgenti e nomi di funzione,
 * non contengono dati personali, e sanificarli (troncamento compreso) renderebbe il logger
 * inutile proprio nel momento in cui serve.
 */
export function descriviErrore(err: unknown): ErroreDescritto {
    try {
        if (err instanceof Error) {
            const extra = err as Error & { digest?: unknown; code?: unknown };
            return {
                messaggio: sanificaMessaggio(err.message || err.name),
                stack: troncaStack(err.stack),
                codice: extra.code === undefined ? undefined : String(extra.code),
                digest: extra.digest === undefined ? undefined : String(extra.digest),
            };
        }
        if (err && typeof err === 'object') {
            const o = err as Record<string, unknown>;
            return {
                messaggio: sanificaMessaggio(
                    typeof o.message === 'string' ? o.message : serializza(o, 300),
                ),
                codice: o.code === undefined ? undefined : String(o.code),
                digest: o.digest === undefined ? undefined : String(o.digest),
            };
        }
        return { messaggio: sanificaMessaggio(String(err)) };
    } catch {
        return { messaggio: '[errore-illeggibile]' };
    }
}

function troncaStack(stack: string | undefined): string | undefined {
    if (!stack) return undefined;
    const righe = stack.split('\n');
    return righe.length > FRAME_MAX + 1
        ? righe.slice(0, FRAME_MAX + 1).join('\n')
        : stack;
}
