import { createHash } from 'node:crypto';

/**
 * Redazione a LISTA BIANCA: tutto è redatto tranne ciò che è esplicitamente permesso.
 *
 * Perché il default è invertito: in questo dominio "campo sensibile" è indecidibile
 * a runtime. `descrizione` compare 113 volte nelle route e vale tanto "Merenda"
 * quanto una diagnosi clinica. Una lista NERA basta dimenticare una chiave — o che
 * qualcuno ne aggiunga una nuova domani — perché un dato sanitario di un minore
 * finisca in chiaro nei log. Con la lista bianca, la dimenticanza è innocua.
 */

/** Sempre redatti, anche se numerici o in forma di uuid. */
const SEGRETI = new Set([
    'password', 'password_temporanea', 'nuova_password', 'token', 'access_token',
    'refresh_token', 'secret', 'apikey', 'api_key', 'authorization', 'cookie',
    'code', 'otp', 'firma', 'signature', 'hash', 'iban', 'piva',
    // Valutazioni: `livello` NON è il livello di log, è il giudizio delle competenze
    // D.M. 14/2024 (A|B|C|D). Accanto a un `alunno_id` (uuid, che passa in chiaro)
    // equivale a scrivere nei log la valutazione di un bambino identificabile.
    'voto', 'valutazione', 'giudizio_globale', 'livello',
]);

/** Sostituiti da un hash stabile: identità non leggibile ma CORRELABILE. */
const DA_HASHARE = new Set([
    'nome', 'cognome', 'nome_completo', 'denominazione', 'email', 'mail',
    'telefono', 'cellulare', 'codice_fiscale', 'cf',
]);

/**
 * Path e URL: MAI in chiaro. In questo repo il token del modulo pubblico è un
 * SEGMENTO di path (`/m/[token]`, `/api/public/forms/[token]/submit`) ed è una
 * capability; le query string trasportano `?userId=`, `?email=`, `?token=`.
 * Passano da `redigiPath`, che ne tiene il solo pattern.
 */
const CHIAVI_PATH = new Set(['path', 'route', 'url']);

/**
 * Le uniche chiavi il cui valore STRINGA esce in chiaro. Sono metadati di
 * dominio: dicono cosa stava succedendo, non a chi.
 */
const IN_CHIARO = new Set([
    'tipo', 'tipo_evento', 'stato', 'esito', 'azione', 'operazione', 'metodo',
    'ordine', 'periodo', 'anno', 'anno_scolastico', 'mese', 'cadenza',
    'ruolo', 'grado', 'classe_sezione', 'sezione', 'bucket', 'mime', 'content_type',
    'estensione', 'formato', 'canale', 'piattaforma', 'ambiente', 'provider',
    'codice', 'error_code', 'evento', 'entita_tipo',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ANCORATO IN FONDO ($), e deve restarci: senza l'ancora, qualunque testo libero che
 * COMINCIA con una data ("2026-07-12 il bambino ha avuto una crisi") verrebbe giudicato
 * auto-descrittivo e finirebbe in chiaro nei log. Solo un timestamp ISO puro passa.
 */
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const SOLE_CIFRE = /^\d+$/;

const PROFONDITA_MAX = 5;
const ELEMENTI_MAX = 20;
const CHIAVI_MAX = 40;
const STRINGA_IN_CHIARO_MAX = 120;
const SEGMENTO_OPACO_MIN = 16;

/**
 * Hash stabile e corto: permette di dire "è sempre lo stesso genitore" senza dire chi.
 *
 * FAIL-CLOSED: senza `LOG_HASH_SALT` non produce un hash debole, redige e basta.
 * Questo repo è pubblico: con il salt noto e uno spazio di input minuscolo (le poche
 * centinaia di nomi/email/telefoni di una scuola) l'hash sarebbe invertibile per forza
 * bruta in un attimo, e la pseudonimizzazione sarebbe solo nominale. Nessun hash è
 * meglio di un hash reversibile. Il salt NON si genera a runtime: un salt casuale per
 * processo spezzerebbe la correlazione tra lambda diverse, che è l'unica ragione per
 * cui questo hash esiste.
 */
export function hashCorrelabile(valore: unknown): string {
    const salt = process.env.LOG_HASH_SALT;
    if (!salt) return '[redatto]';
    return '#' + createHash('sha256').update(salt + String(valore)).digest('hex').slice(0, 8);
}

/**
 * Riduce un path al suo PATTERN: via la query string, e ogni segmento che possa essere
 * un identificativo, una credenziale o un dato viene sostituito da un segnaposto.
 * `/m/8f3a9c2e-secretissimo-token` → `/m/[tok]`, `/api/alunni/42` → `/api/alunni/[n]`.
 */
export function redigiPath(v: string): string {
    const senzaQuery = v.split('?')[0].split('#')[0];
    return senzaQuery
        .split('/')
        .map((seg) => {
            if (seg === '') return seg;
            if (UUID.test(seg)) return '[id]';
            if (seg.length >= SEGMENTO_OPACO_MIN) return '[tok]';
            if (SOLE_CIFRE.test(seg)) return '[n]';
            return seg;
        })
        .join('/');
}

function redigiStringa(v: string): string {
    return `[redatto:str/${v.length}]`;
}

function tronca(v: string): string {
    return v.length > STRINGA_IN_CHIARO_MAX ? v.slice(0, STRINGA_IN_CHIARO_MAX) + '…' : v;
}

/** Un valore stringa esce in chiaro solo se è "auto-descrittivo" (uuid o data). */
function stringaAutoDescrittiva(v: string): boolean {
    return UUID.test(v) || DATA_ISO.test(v);
}

function redactValore(chiave: string | null, v: unknown, prof: number, visti: WeakSet<object>): unknown {
    if (chiave !== null) {
        const k = chiave.toLowerCase();
        if (SEGRETI.has(k)) return '[redatto]';
        if (DA_HASHARE.has(k)) return v === null || v === undefined ? v : hashCorrelabile(v);
    }

    if (v === null || v === undefined) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
    if (v instanceof Date) return v.toISOString();

    if (typeof v === 'string') {
        if (chiave !== null) {
            const k = chiave.toLowerCase();
            if (CHIAVI_PATH.has(k)) return tronca(redigiPath(v));
            if (IN_CHIARO.has(k)) return tronca(v);
        }
        if (stringaAutoDescrittiva(v)) return v;
        return redigiStringa(v);
    }

    if (prof >= PROFONDITA_MAX) return '[profondità-max]';

    if (Array.isArray(v)) {
        if (visti.has(v)) return '[ciclo]';
        visti.add(v);
        const testa = v.slice(0, ELEMENTI_MAX).map((el) => redactValore(chiave, el, prof + 1, visti));
        return v.length > ELEMENTI_MAX ? [...testa, `[+${v.length - ELEMENTI_MAX} elementi]`] : testa;
    }

    if (typeof v === 'object') {
        if (visti.has(v as object)) return '[ciclo]';
        visti.add(v as object);
        // Object.create(null): il body di una richiesta è input non fidato, e su un
        // oggetto letterale `out['__proto__'] = …` invocherebbe il setter del prototipo.
        const out: Record<string, unknown> = Object.create(null);
        // Object.keys (non Object.entries): entries INVOCA i getter, quindi un getter
        // che lancia farebbe collassare l'intero oggetto. Qui si legge campo per campo,
        // dentro un try: si perde il campo rotto, non tutta la riga di log.
        const chiavi = Object.keys(v as object);
        let n = 0;
        for (const k of chiavi) {
            if (n++ >= CHIAVI_MAX) {
                out['[…]'] = `[+${chiavi.length - CHIAVI_MAX} chiavi]`;
                break;
            }
            try {
                out[k] = redactValore(k, (v as Record<string, unknown>)[k], prof + 1, visti);
            } catch {
                out[k] = '[campo-illeggibile]';
            }
        }
        return out;
    }

    return '[?]';
}

/**
 * Redige un valore qualunque. NON lancia mai: è chiamata dentro un logger, e un
 * logger che lancia trasforma una 200 in 500 su tutte le route.
 */
export function redact(v: unknown): unknown {
    try {
        return redactValore(null, v, 0, new WeakSet());
    } catch {
        return '[redazione-fallita]';
    }
}
