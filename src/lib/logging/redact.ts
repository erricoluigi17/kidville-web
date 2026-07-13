import { createHash } from 'node:crypto';
import { redigiPath } from './path';

/**
 * `redigiPath` resta esportata DA QUI, anche se ora vive in `./path`: è la firma che il resto
 * del repo importa (`context.ts`, `app-log.ts`, `external.ts`, `supabase-fetch.ts`, i test), e
 * un modulo di logging non è il posto dove si rompono trenta call-site per un refactor. Il
 * codice però sta in un file SENZA IMPORT, perché la stessa euristica serve al middleware
 * (Edge), all'instrumentation e al browser — tre runtime che `node:crypto` non ce l'hanno.
 * Vedi la testata di `path.ts`.
 */
export { redigiPath };

/**
 * Redazione a LISTA BIANCA.
 *
 * Perché il default è invertito: in questo dominio "campo sensibile" è indecidibile
 * a runtime. `descrizione` compare 113 volte nelle route e vale tanto "Merenda"
 * quanto una diagnosi clinica. Una lista NERA basta dimenticare una chiave — o che
 * qualcuno ne aggiunga una nuova domani — perché un dato sanitario di un minore
 * finisca in chiaro nei log. Con la lista bianca, la dimenticanza è innocua.
 *
 * Cosa passa, ESATTAMENTE (il resto è redatto):
 *
 * - STRINGHE: chiuse per default. Escono in chiaro solo se la chiave è in `IN_CHIARO`
 *   (metadati di dominio: dicono cosa succedeva, non a chi) o se il valore è
 *   auto-descrittivo (uuid, timestamp ISO puro).
 *   Unica deroga: `digest` (il codice d'errore che Next mostra all'utente) esce in chiaro
 *   SOLO se anche il valore ha la forma di un digest — la chiave apre, il valore conferma.
 *   Vedi `CHIAVI_DIGEST`: senza quel campo la correlazione utente↔log è rotta; con la chiave
 *   sola sarebbe un canale di testo libero verso la tabella.
 * - NUMERI, BOOLEANI, DATE: passano, perché da soli non identificano nessuno e sono
 *   ciò che rende un log leggibile (conteggi, flag, istanti).
 *   ⚠️ MA un numero può essere un DATO: `voto_numerico: 7`, `media: 4.5` sono la
 *   valutazione di un minore, e accanto a un `alunno_id` (uuid, in chiaro) sarebbero
 *   il suo giudizio scritto nei log. Per questo la sensibilità si decide sulla CHIAVE,
 *   non sul tipo: qualunque chiave che contenga una `RADICE_SEGRETA` è redatta a
 *   prescindere dal tipo del valore.
 * - CHIAVI: confrontate NORMALIZZATE (minuscolo, senza `_` e `-`), così `votoNumerico`,
 *   `voto_numerico` e `VOTO-NUMERICO` cadono nello stesso secchio.
 */

/** Normalizza la chiave: `codice_fiscale`, `codiceFiscale`, `CODICE-FISCALE` → `codicefiscale`. */
function normalizzaChiave(k: string): string {
    return k.toLowerCase().replace(/[_-]/g, '');
}

function insieme(...chiavi: string[]): Set<string> {
    return new Set(chiavi.map(normalizzaChiave));
}

/**
 * Radici sensibili: qualunque chiave che CONTENGA una di queste è redatta, di qualunque
 * tipo sia il valore. La corrispondenza esatta non basta: il repo ha già `voto_numerico`
 * (grades), `media` (prospetto: la media per materia di un alunno), `giudizio`,
 * `votoNumerico`. Una lista di nomi esatti li lascerebbe passare tutti perché sono numeri.
 * Falsi positivi noti e accettati: `multimedia`/`mediateca` finiscono redatti — si perde
 * un metadato irrilevante, che è esattamente il verso in cui vogliamo sbagliare.
 */
const RADICI_SEGRETE = [
    'voto', 'media', 'giudizio', 'livello', 'valutazione', 'punteggio',
    'password', 'token', 'secret', 'firma', 'iban', 'otp',
];

/** Segreti per nome esatto (quelli che non hanno una radice utile). */
const SEGRETI = insieme(
    'apikey', 'api_key', 'authorization', 'cookie', 'code', 'hash', 'piva', 'signature',
);

/** Sostituiti da un hash stabile: identità non leggibile ma CORRELABILE. */
const DA_HASHARE = insieme(
    'nome', 'cognome', 'nome_completo', 'denominazione', 'email', 'mail',
    'telefono', 'cellulare', 'codice_fiscale', 'cf',
);

/**
 * Path e URL: MAI in chiaro. In questo repo il token del modulo pubblico è un
 * SEGMENTO di path (`/m/[token]`, `/api/public/forms/[token]/submit`) ed è una
 * capability; le query string trasportano `?userId=`, `?email=`, `?token=`.
 * Passano da `redigiPath`, che ne tiene il solo pattern.
 */
const CHIAVI_PATH = insieme('path', 'route', 'url');

/**
 * Le uniche chiavi il cui valore STRINGA esce in chiaro. Sono metadati di dominio.
 * NB: `codice` NON è qui. Sembra innocuo, ma la valutazione di competenza viaggia
 * anche come `Livello.codice: 'A'|'B'|'C'|'D'` (src/lib/competenze/modello.ts): stessa
 * informazione di `livello`, altro nome. I codici d'errore hanno il loro campo dedicato.
 */
const IN_CHIARO = insieme(
    'tipo', 'tipo_evento', 'stato', 'esito', 'azione', 'operazione', 'metodo',
    'ordine', 'periodo', 'anno', 'anno_scolastico', 'mese', 'cadenza',
    'ruolo', 'grado', 'classe_sezione', 'sezione', 'bucket', 'mime', 'content_type',
    'estensione', 'formato', 'canale', 'piattaforma', 'ambiente', 'provider',
    'error_code', 'evento', 'entita_tipo',
);

/**
 * IL `digest` DI NEXT — l'unica deroga alla lista bianca, e vale la pena scrivere perché.
 *
 * IL PROBLEMA. `error.tsx` e `global-error.tsx` mostrano il digest all'utente come «il codice da
 * dare alla segreteria»: è l'unico numero che un genitore ha in mano quando telefona. Dall'altra
 * parte, `instrumentation.ts` (`onRequestError`) è l'unico punto che vede lo STACK VERO di un
 * errore di render — e lo passa in `campi.digest`, che finisce in `app_log.contesto`. Ma
 * `digest` non era in lista bianca: in tabella usciva come `[redatto:str/10]`. Risultato: il
 * genitore detta un codice che in SQL non trova NESSUNA riga, e la riga con lo stack — che c'è,
 * ed è a un `where` di distanza — resta irraggiungibile. Non è un campo comodo che manca: è la
 * correlazione utente↔log che è rotta in due.
 *
 * PERCHÉ NON VIOLA LA REGOLA 8 («non allargare la lista bianca perché sarebbe comodo»). Il
 * digest di Next è un HASH generato dal FRAMEWORK a partire da messaggio e stack dell'errore:
 * non è un dato personale, non è invertibile, non lo scrive nessun utente. Non è un dato che si
 * vuole vedere: è la CHIAVE con cui si ritrova la riga che il dato ce l'ha già.
 *
 * PERCHÉ LA CHIAVE DA SOLA NON BASTA (ed è qui che la deroga si stringe). `redact()` non gira
 * solo sui campi che scriviamo noi: gira sul BODY GREZZO di ogni richiesta — `parseBody` fa
 * `impostaPayload('body', raw)` PRIMA della validazione zod, apposta per poter diagnosticare i
 * 400. Mettere `digest` in `IN_CHIARO` e basta significherebbe quindi aprire un canale di TESTO
 * LIBERO (fino a 120 caratteri, in chiaro, in tabella) a chiunque possa fare una POST: basta
 * spedire `{"digest": "<quello che ti pare>"}`. La lista bianca resterebbe "a lista bianca" solo
 * di nome.
 *
 * Perciò: LA CHIAVE APRE, IL VALORE CONFERMA. Passa in chiaro solo ciò che ha la FORMA di un
 * digest — un token opaco esadecimale. Tutto il resto sotto quella chiave resta redatto
 * esattamente come oggi (fail-closed: si perde la correlazione, non si guadagna una falla).
 * Cosa NON passa, e sono i casi che contano:
 *  · testo libero, nomi, note, diagnosi (hanno spazi, accenti, lettere fuori dall'esadecimale);
 *  · un'email (la `@` non è esadecimale) e un codice fiscale (`RSSMRA…`: R, S, M non lo sono);
 *  · i digest di CONTROLLO di Next, che non sono hash ma stringhe con dentro un PATH —
 *    `NEXT_REDIRECT;replace;/m/<token>;307;`. In questo repo il path è una CREDENZIALE
 *    (`/m/[token]` è una capability): è il caso in cui una lista bianca ingenua avrebbe versato
 *    nei log proprio ciò che `redigiPath` esiste per togliere. Il `;` non è esadecimale: redatto.
 */
const CHIAVI_DIGEST = insieme('digest');

/**
 * La forma di un digest: solo esadecimale. Copre le due che Next produce davvero — il digest
 * numerico degli errori di Server Component (`stringHash` → «2043430104») e gli hash esadecimali
 * — e NON copre nient'altro che possa essere un dato. Il tetto a 64 caratteri è quello di uno
 * sha256 in esadecimale: oltre, non è un digest, è qualcos'altro.
 */
const DIGEST_PLAUSIBILE = /^[0-9a-f]{4,64}$/i;

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
const STACK_RIGHE_MAX = 5;

function eSegreta(chiaveNorm: string): boolean {
    if (SEGRETI.has(chiaveNorm)) return true;
    return RADICI_SEGRETE.some((radice) => chiaveNorm.includes(radice));
}

/**
 * Hash stabile e corto: permette di dire "è sempre lo stesso genitore" senza dire chi.
 *
 * FAIL-CLOSED due volte:
 * 1. senza `LOG_HASH_SALT` non produce un hash debole, redige e basta. Questo repo è
 *    pubblico: con il salt noto e uno spazio di input minuscolo (le poche centinaia di
 *    nomi/email di una scuola) l'hash sarebbe invertibile per forza bruta, e la
 *    pseudonimizzazione sarebbe solo nominale. Il salt NON si genera a runtime: uno
 *    casuale per processo spezzerebbe la correlazione tra lambda diverse, che è l'unica
 *    ragione per cui questo hash esiste.
 * 2. hasha solo `string | number`. `String({...})` è `"[object Object]"` per QUALUNQUE
 *    oggetto: l'hash sarebbe identico per persone diverse, e un hash "correlabile" che
 *    correla il falso è peggio di nessun hash.
 */
export function hashCorrelabile(valore: unknown): string {
    const salt = process.env.LOG_HASH_SALT;
    if (!salt) return '[redatto]';
    if (typeof valore !== 'string' && typeof valore !== 'number') return '[redatto]';
    return '#' + createHash('sha256').update(salt + String(valore)).digest('hex').slice(0, 8);
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

/**
 * Un Error non può uscire come `{}`. `message` e `stack` non sono enumerabili, quindi
 * `Object.keys` non li vede: senza questo ramo l'errore — il caso d'uso numero uno di un
 * logger — sparirebbe, e chiunque cabli il logger sarebbe tentato di bypassare `redact`
 * per gli errori. Ma `message` contiene benissimo un'email o un nome: esce redatto.
 */
function redigiErrore(v: Error): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    out.name = v.name;
    out.message = redigiStringa(v.message);
    if (typeof v.stack === 'string') {
        out.stack = v.stack.split('\n').slice(0, STACK_RIGHE_MAX).map(redigiStringa);
    }
    return out;
}

function redactValore(chiave: string | null, v: unknown, prof: number, visti: Set<object>): unknown {
    const k = chiave === null ? null : normalizzaChiave(chiave);

    if (k !== null) {
        if (eSegreta(k)) return '[redatto]';
        if (DA_HASHARE.has(k)) return v === null || v === undefined ? v : hashCorrelabile(v);
    }

    if (v === null || v === undefined) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '[data-invalida]' : v.toISOString();
    if (v instanceof Error) return redigiErrore(v);

    if (typeof v === 'string') {
        if (k !== null) {
            if (CHIAVI_PATH.has(k)) return tronca(redigiPath(v));
            if (IN_CHIARO.has(k)) return tronca(v);
            // LA CHIAVE APRE, IL VALORE CONFERMA (vedi `CHIAVI_DIGEST`): niente `tronca`, perché
            // un digest o ci sta intero — e allora si può cercare — o non serve a niente. Se la
            // forma non torna si cade sotto, e la stringa esce redatta come qualunque altra:
            // la deroga non ha un ramo "quasi in chiaro".
            if (CHIAVI_DIGEST.has(k) && DIGEST_PLAUSIBILE.test(v)) return v;
        }
        if (stringaAutoDescrittiva(v)) return v;
        return redigiStringa(v);
    }

    if (prof >= PROFONDITA_MAX) return '[profondità-max]';

    // `visti` traccia il PERCORSO, non tutti gli oggetti già incontrati: alla fine della
    // ricorsione l'oggetto viene tolto. Altrimenti un riferimento semplicemente CONDIVISO
    // (`{ a: x, b: x }`, non ciclico) verrebbe etichettato `[ciclo]` e il dato sparirebbe.
    if (visti.has(v as object)) return '[ciclo]';
    visti.add(v as object);

    try {
        if (Array.isArray(v)) {
            const testa = v.slice(0, ELEMENTI_MAX).map((el) => redactValore(chiave, el, prof + 1, visti));
            return v.length > ELEMENTI_MAX ? [...testa, `[+${v.length - ELEMENTI_MAX} elementi]`] : testa;
        }

        // Object.create(null): il body di una richiesta è input non fidato, e su un
        // oggetto letterale `out['__proto__'] = …` invocherebbe il setter del prototipo.
        const out: Record<string, unknown> = Object.create(null);
        // Object.keys (non Object.entries): entries INVOCA i getter, quindi un getter che
        // lancia farebbe collassare l'intero oggetto. Qui si legge campo per campo, dentro
        // un try: si perde il campo rotto, non tutta la riga di log.
        const chiavi = Object.keys(v as object);
        let n = 0;
        for (const kk of chiavi) {
            if (n++ >= CHIAVI_MAX) {
                out['[…]'] = `[+${chiavi.length - CHIAVI_MAX} chiavi]`;
                break;
            }
            try {
                out[kk] = redactValore(kk, (v as Record<string, unknown>)[kk], prof + 1, visti);
            } catch {
                out[kk] = '[campo-illeggibile]';
            }
        }
        return out;
    } finally {
        visti.delete(v as object);
    }
}

/**
 * Redige un valore qualunque. NON lancia mai: è chiamata dentro un logger, e un
 * logger che lancia trasforma una 200 in 500 su tutte le route.
 */
export function redact(v: unknown): unknown {
    try {
        return redactValore(null, v, 0, new Set());
    } catch {
        return '[redazione-fallita]';
    }
}
