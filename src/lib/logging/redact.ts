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
    'voto', 'valutazione', 'giudizio_globale',
]);

/** Sostituiti da un hash stabile: identità non leggibile ma CORRELABILE. */
const DA_HASHARE = new Set([
    'nome', 'cognome', 'nome_completo', 'denominazione', 'email', 'mail',
    'telefono', 'cellulare', 'codice_fiscale', 'cf',
]);

/**
 * Le uniche chiavi il cui valore STRINGA esce in chiaro. Sono metadati di
 * dominio: dicono cosa stava succedendo, non a chi.
 */
const IN_CHIARO = new Set([
    'tipo', 'tipo_evento', 'stato', 'esito', 'azione', 'operazione', 'metodo',
    'ordine', 'periodo', 'anno', 'anno_scolastico', 'mese', 'cadenza', 'livello',
    'ruolo', 'grado', 'classe_sezione', 'sezione', 'bucket', 'mime', 'content_type',
    'estensione', 'formato', 'canale', 'piattaforma', 'ambiente', 'provider',
    'codice', 'error_code', 'evento', 'entita_tipo', 'route', 'path',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ANCORATO IN FONDO ($), e deve restarci: senza l'ancora, qualunque testo libero che
 * COMINCIA con una data ("2026-07-12 il bambino ha avuto una crisi") verrebbe giudicato
 * auto-descrittivo e finirebbe in chiaro nei log. Solo un timestamp ISO puro passa.
 */
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const PROFONDITA_MAX = 5;
const ELEMENTI_MAX = 20;
const CHIAVI_MAX = 40;
const STRINGA_IN_CHIARO_MAX = 120;

const SALT = process.env.LOG_HASH_SALT ?? 'kidville-log';

/** Hash stabile e corto: permette di dire "è sempre lo stesso genitore" senza dire chi. */
export function hashCorrelabile(valore: unknown): string {
    return '#' + createHash('sha256').update(SALT + String(valore)).digest('hex').slice(0, 8);
}

function redigiStringa(v: string): string {
    return `[redatto:str/${v.length}]`;
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
        if (chiave !== null && IN_CHIARO.has(chiave.toLowerCase())) {
            return v.length > STRINGA_IN_CHIARO_MAX ? v.slice(0, STRINGA_IN_CHIARO_MAX) + '…' : v;
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
        const out: Record<string, unknown> = {};
        let n = 0;
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (n++ >= CHIAVI_MAX) {
                out['[…]'] = `[+${Object.keys(v as object).length - CHIAVI_MAX} chiavi]`;
                break;
            }
            out[k] = redactValore(k, val, prof + 1, visti);
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
