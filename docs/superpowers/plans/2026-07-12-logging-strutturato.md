# Logging strutturato pervasivo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere osservabile ogni superficie che può fallire in Kidville Web, così che un bug segnalato dall'utente sia diagnosticabile leggendo i log, senza riprodurlo.

**Architecture:** Un modulo `src/lib/logging/` senza dipendenze esterne emette righe `marker + chiave=valore` su stdout (→ Vercel Runtime Logs, retention 1 giorno) e persiste warn/error più i successi di una allowlist di eventi critici su una tabella Supabase `app_log` (retention 30 giorni). La copertura si ottiene da **pochi colli di bottiglia** — `global.fetch` sui client Supabase (tutte le query DB), `withRoute()` sugli export delle 239 route, `parseBody`/`parseQuery` (payload), i gate auth (identità), `src/instrumentation.ts` (errori non gestiti server), `src/instrumentation-client.ts` (errori e fetch client) — e da un contesto di richiesta `AsyncLocalStorage` che li correla con un `requestId`.

**Tech Stack:** Next.js 16.2.4 (App Router, runtime Node), TypeScript strict, Supabase (`@supabase/ssr` 0.10.3 + `supabase-js` 2.105.4), zod 4, Vitest 4, Playwright, Capacitor 8, Vercel Pro.

**Spec di riferimento:** `docs/superpowers/specs/2026-07-12-logging-strutturato-design.md`

**Branch:** `feat/logging-strutturato` (già creato, allineato a `main`)

---

## Struttura dei file

### Nuovi

| File | Responsabilità |
|---|---|
| `src/lib/logging/redact.ts` | Redazione a lista bianca. **Unica** fonte di verità su cosa può uscire in chiaro. Nessuna dipendenza da Next o Supabase. |
| `src/lib/logging/serialize.ts` | Serializzatore fail-open: cycle guard, cap di profondità e dimensione. Non lancia mai. |
| `src/lib/logging/logger.ts` | Emissione delle righe (marker + logfmt), livelli, guardia di silenzio nei test, fire-and-forget verso il sink DB. |
| `src/lib/logging/context.ts` | `AsyncLocalStorage` della richiesta: `requestId`, `path`, `userId`, `ruolo`, `scuolaId`, `payload` redatto, guardia di rientranza. |
| `src/lib/logging/with-route.ts` | Wrapper degli export delle route. **Solo osservabilità**: non assorbe gate né zod, non legge il body, rilancia sempre. |
| `src/lib/logging/external.ts` | `externalFetch()`: chiamate a provider esterni con **corpo dell'errore obbligatorio**. |
| `src/lib/logging/app-log.ts` | Sink su Supabase: circuit-breaker, fingerprint, mai ricorsivo. |
| `src/lib/logging/client.ts` | Logger del browser/WebView: coda in RAM + IndexedDB, flush via `sendBeacon`. Nessun import Node. |
| `src/instrumentation.ts` | `register()` (preflight configurazione) + `onRequestError` (rete di sicurezza server). **In `src/`, non nella radice.** |
| `src/instrumentation-client.ts` | Patch di `fetch`, `window.onerror`, `unhandledrejection`. Gira **prima dell'hydration**. |
| `src/app/error.tsx` | Boundary d'errore che **logga da sé** (obbligatorio: la sua presenza spegne `window.onerror` per gli errori React). |
| `src/app/global-error.tsx` | Boundary del root layout. Deve ridichiarare `<html>`/`<body>`. |
| `src/app/api/logs/route.ts` | Ingestion degli errori client. Endpoint ostile: rate-limit, cap byte, zod, batch max 20. |
| `supabase/migrations/20260713090000_app_log.sql` | Tabella `app_log` (RLS deny-all), RPC `app_log_registra`, funzione + job di purge a 30 giorni. |
| `__tests__/lib/logging-redact.test.ts` | **Il lock anti-PII.** Se è rosso, non si va in produzione. |
| `__tests__/lib/logging-serialize.test.ts` | Fail-open. |
| `__tests__/lib/logging-with-route.test.ts` | Il wrapper non altera status, body, firma; rilancia. |
| `__tests__/lib/logging-supabase-fetch.test.ts` | Regressione: il `fetch` custom **viene davvero invocato** dai client Supabase. |
| `__tests__/api/logs-ingestion.test.ts` | La route di ingestion: rate-limit, 413, batch. |
| `__tests__/architecture/logging-coverage.test.ts` | Il lock incrementale della Fase 2. |

### Modificati

| File | Modifica |
|---|---|
| `src/lib/supabase/server-client.ts` | `global.fetch` strumentato su **tutti** i factory + nuovo `createLogClient()` **senza** strumentazione (anti-ricorsione). |
| `src/lib/validation/http.ts` | `parseBody`/`parseQuery`/`parseData` depositano il payload **redatto** nel contesto. |
| `src/lib/auth/require-staff.ts` | I gate scrivono `userId`/`ruolo`/`scuolaId` nel contesto; `console.warn` → `logger`. |
| `src/middleware.ts` | Genera e inietta `x-request-id`. |
| `src/lib/push/native-push.ts` | Il corpo dell'errore FCM smette di essere buttato via. |
| `src/app/api/{push/dispatch,notifiche/promemoria,mensa/allergie-check,pagamenti/solleciti/run,pagamenti/fattura/sync}/route.ts` | Battito cardiaco del cron. |
| `playwright.config.ts` | `webServer.env = { KV_LOG_LEVEL: 'silent' }`. |
| `next.config.ts` | Commento-lock su `compiler.removeConsole`. |
| `eslint.config.mjs` | `no-console` con override (Fase 3). |
| `__tests__/api/zod-coverage.test.ts` | `'logs'` in `GRUPPI_COPERTI`. |
| `PRD REGISTRO ELETTRONICO.md` | Changelog datato (obbligo AGENTS.md). |

---

# FASE 1 — Infrastruttura

## Task 1: Redazione a lista bianca (il lock anti-PII)

Questo è il task più importante del piano. Tutto il resto dipende da qui: se questa funzione lascia passare un dato, il logging diventa una fuga di dati sanitari di minori.

**Files:**
- Create: `src/lib/logging/redact.ts`
- Test: `__tests__/lib/logging-redact.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-redact.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redact, hashCorrelabile } from '@/lib/logging/redact';

/**
 * Campione REALE del dominio: se anche un solo valore sopravvive alla redazione,
 * il logging sta versando dati personali di minori nei log di Vercel.
 * Questo test è il gate: se è rosso, non si va in produzione.
 */
const CAMPIONE = {
    // salute (art. 9 GDPR, minori)
    allergie: 'arachidi e crostacei',
    diagnosi: 'disturbo specifico apprendimento',
    certificato_medico: 'cert-2026-0031.pdf',
    motivo: 'febbre alta',
    // testo libero
    descrizione: 'ha avuto una crisi durante la mensa',
    note: 'la mamma chiede di essere richiamata',
    testo: 'contenuto della comunicazione',
    contenuto: 'messaggio in chat',
    giudizio: 'raggiunge pienamente gli obiettivi',
    // identità
    nome: 'Mario',
    cognome: 'Rossi',
    email: 'genitore@example.com',
    codice_fiscale: 'RSSMRA80A01H501U',
    indirizzo: 'Via Roma 1',
    telefono: '3331234567',
    // sicurezza e valore legale
    password: 'Segreta.2026!',
    token: 'eyJhbGciOiJIUzI1NiJ9',
    code: '482913',
    firma: 'base64-della-firma-FEA',
    iban: 'IT60X0542811101000000123456',
    // valutazione (numerica: NON deve passare solo perché è un numero)
    voto: 7,
    valutazione: 9,
};

describe('redact — lista bianca', () => {
    it('nessun valore del campione sopravvive', () => {
        const out = JSON.stringify(redact(CAMPIONE));
        for (const [chiave, valore] of Object.entries(CAMPIONE)) {
            expect(out, `il valore di "${chiave}" è sopravvissuto`).not.toContain(String(valore));
        }
    });

    it('conserva la FORMA: chiavi presenti, tipo e lunghezza delle stringhe', () => {
        const out = redact({ note: 'ciao' }) as Record<string, string>;
        expect(Object.keys(out)).toEqual(['note']);
        expect(out.note).toBe('[redatto:str/4]');
    });

    it('lascia in chiaro ciò che serve al debug e non identifica nessuno', () => {
        const out = redact({
            id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            section_id: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529',
            tipo: 'assenza',
            stato: 'confermato',
            azione: 'insert',
            periodo: '2026-07',
            attivo: true,
            quantita: 3,
        }) as Record<string, unknown>;
        expect(out.id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        expect(out.section_id).toBe('d53b0fbc-a9eb-4073-b302-73d1d5abd529');
        expect(out.tipo).toBe('assenza');
        expect(out.stato).toBe('confermato');
        expect(out.azione).toBe('insert');
        expect(out.periodo).toBe('2026-07');
        expect(out.attivo).toBe(true);
        expect(out.quantita).toBe(3);
    });

    it('nome/cognome/email diventano un hash STABILE (correlabile, non identificante)', () => {
        const a = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const b = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const c = redact({ email: 'altro@example.com' }) as Record<string, string>;
        expect(a.email).toBe(b.email);          // stabile → posso dire "è sempre lo stesso"
        expect(a.email).not.toBe(c.email);      // distingue persone diverse
        expect(a.email).not.toContain('genitore');
        expect(a.email).toMatch(/^#[0-9a-f]{8}$/);
    });

    it('i SEGRETI spariscono anche se numerici o uuid', () => {
        const out = redact({
            voto: 7,
            token: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            code: 482913,
        }) as Record<string, string>;
        expect(out.voto).toBe('[redatto]');
        expect(out.token).toBe('[redatto]');
        expect(out.code).toBe('[redatto]');
    });

    it('una stringa nuda (senza chiave) è sempre redatta', () => {
        expect(redact('crisi convulsiva')).toBe('[redatto:str/16]');
    });

    it('regge annidamento, array, profondità e cicli senza lanciare', () => {
        const ciclico: Record<string, unknown> = { tipo: 'x' };
        ciclico.self = ciclico;
        expect(() => redact(ciclico)).not.toThrow();
        expect(() => redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).not.toThrow();
        const arr = redact({ figli: [{ nome: 'A' }, { nome: 'B' }] }) as { figli: unknown[] };
        expect(arr.figli).toHaveLength(2);
        expect(JSON.stringify(arr)).not.toContain('"A"');
    });

    it('una chiave sconosciuta con valore stringa è redatta (default chiuso)', () => {
        const out = redact({ campo_inventato_domani: 'dato sensibilissimo' }) as Record<string, string>;
        expect(out.campo_inventato_domani).toBe('[redatto:str/19]');
    });

    it('hashCorrelabile è deterministico e corto', () => {
        expect(hashCorrelabile('x')).toBe(hashCorrelabile('x'));
        expect(hashCorrelabile('x')).toMatch(/^#[0-9a-f]{8}$/);
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-redact.test.ts`
Atteso: FAIL — `Failed to resolve import "@/lib/logging/redact"`.

- [ ] **Step 3: Implementa la redazione**

Crea `src/lib/logging/redact.ts`:

```ts
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
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

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
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Comando: `npx vitest run __tests__/lib/logging-redact.test.ts`
Atteso: PASS, 9 test verdi.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logging/redact.ts __tests__/lib/logging-redact.test.ts
git commit -m "feat(logging): redazione a lista bianca + lock anti-PII"
```

---

## Task 2: Serializzatore fail-open

Un `JSON.stringify` su un oggetto ciclico o su un `BigInt` **lancia**. Se lancia dentro il logger, ogni richiesta di tutte le 239 route diventa un 500.

**Files:**
- Create: `src/lib/logging/serialize.ts`
- Test: `__tests__/lib/logging-serialize.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-serialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializza, descriviErrore } from '@/lib/logging/serialize';

describe('serializza — non lancia MAI', () => {
    it('regge un oggetto ciclico', () => {
        const c: Record<string, unknown> = { a: 1 };
        c.self = c;
        expect(() => serializza(c)).not.toThrow();
    });

    it('regge BigInt e Symbol (JSON.stringify li rifiuta)', () => {
        expect(() => serializza({ n: 10n, s: Symbol('x') })).not.toThrow();
    });

    it('tronca alla dimensione massima', () => {
        const out = serializza({ x: 'a'.repeat(10_000) }, 200);
        expect(out.length).toBeLessThanOrEqual(200);
    });

    it('su input impossibile ritorna un segnaposto, non un throw', () => {
        const cattivo = { get boom() { throw new Error('no'); } };
        expect(() => serializza(cattivo)).not.toThrow();
    });
});

describe('descriviErrore', () => {
    it('estrae messaggio e stack da un Error', () => {
        const e = new Error('esploso');
        const d = descriviErrore(e);
        expect(d.messaggio).toBe('esploso');
        expect(d.stack).toContain('Error: esploso');
    });

    it('accetta anche un non-Error senza lanciare', () => {
        expect(descriviErrore('stringa').messaggio).toBe('stringa');
        expect(descriviErrore(null).messaggio).toBe('null');
        expect(descriviErrore({ code: 'PGRST204', message: 'colonna assente' }).messaggio)
            .toBe('colonna assente');
    });

    it('propaga il digest degli errori Server Component', () => {
        const e = Object.assign(new Error('x'), { digest: 'abc123' });
        expect(descriviErrore(e).digest).toBe('abc123');
    });

    it('tronca lo stack a un numero limitato di frame', () => {
        const e = new Error('x');
        e.stack = 'Error: x\n' + Array.from({ length: 50 }, (_, i) => `    at f${i}`).join('\n');
        expect(descriviErrore(e).stack!.split('\n').length).toBeLessThanOrEqual(11);
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-serialize.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa**

Crea `src/lib/logging/serialize.ts`:

```ts
/**
 * Serializzazione difensiva per il logger.
 *
 * Regola d'oro: NIENTE qui dentro può lanciare. Un throw nel logger trasforma
 * una risposta 200 in un 500 su TUTTE le route. Meglio un log incompleto che
 * un'app rotta dall'osservabilità.
 */

const DIMENSIONE_MAX = 3_500; // Vercel tronca le righe lunghe: sotto la soglia
const FRAME_MAX = 10;

export function serializza(v: unknown, max: number = DIMENSIONE_MAX): string {
    let s: string;
    try {
        const visti = new WeakSet<object>();
        s = JSON.stringify(v, (_k, val) => {
            if (typeof val === 'bigint') return `${val.toString()}n`;
            if (typeof val === 'symbol' || typeof val === 'function') return `[${typeof val}]`;
            if (val && typeof val === 'object') {
                if (visti.has(val as object)) return '[ciclo]';
                visti.add(val as object);
            }
            return val;
        }) ?? String(v);
    } catch {
        try {
            s = String(v);
        } catch {
            return '[non-serializzabile]';
        }
    }
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export interface ErroreDescritto {
    messaggio: string;
    stack?: string;
    codice?: string;
    digest?: string;
}

/**
 * Normalizza qualunque cosa sia stata lanciata. Accetta Error, stringhe, oggetti
 * PostgREST (`{ code, message }`) e `null`.
 */
export function descriviErrore(err: unknown): ErroreDescritto {
    try {
        if (err instanceof Error) {
            const extra = err as Error & { digest?: unknown; code?: unknown };
            return {
                messaggio: err.message || err.name,
                stack: troncaStack(err.stack),
                codice: extra.code === undefined ? undefined : String(extra.code),
                digest: extra.digest === undefined ? undefined : String(extra.digest),
            };
        }
        if (err && typeof err === 'object') {
            const o = err as Record<string, unknown>;
            return {
                messaggio: typeof o.message === 'string' ? o.message : serializza(o, 300),
                codice: o.code === undefined ? undefined : String(o.code),
                digest: o.digest === undefined ? undefined : String(o.digest),
            };
        }
        return { messaggio: String(err) };
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
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Comando: `npx vitest run __tests__/lib/logging-serialize.test.ts`
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logging/serialize.ts __tests__/lib/logging-serialize.test.ts
git commit -m "feat(logging): serializzatore fail-open (cicli, BigInt, cap dimensione)"
```

---

## Task 3: Contesto di richiesta (AsyncLocalStorage)

**Files:**
- Create: `src/lib/logging/context.ts`
- Test: `__tests__/lib/logging-context.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
    conContesto, contesto, impostaUtente, impostaPayload,
    inLogger, entraNelLogger,
} from '@/lib/logging/context';

describe('contesto di richiesta', () => {
    it('fuori da una richiesta è undefined (non lancia)', () => {
        expect(contesto()).toBeUndefined();
    });

    it('dentro conContesto espone requestId e path', async () => {
        await conContesto({ requestId: 'r1', path: '/api/x' }, async () => {
            expect(contesto()?.requestId).toBe('r1');
            expect(contesto()?.path).toBe('/api/x');
        });
    });

    it('impostaUtente arricchisce il contesto DELLA richiesta corrente', async () => {
        await conContesto({ requestId: 'r2', path: '/api/y' }, async () => {
            impostaUtente({ userId: 'u1', ruolo: 'educator', scuolaId: 's1' });
            expect(contesto()?.userId).toBe('u1');
            expect(contesto()?.ruolo).toBe('educator');
            expect(contesto()?.scuolaId).toBe('s1');
        });
    });

    it('impostaPayload conserva l\'ultimo payload validato', async () => {
        await conContesto({ requestId: 'r3', path: '/api/z' }, async () => {
            impostaPayload('body', { tipo: 'assenza' });
            expect(contesto()?.payload).toEqual({ body: { tipo: 'assenza' } });
        });
    });

    it('due richieste concorrenti NON si contaminano', async () => {
        const visto: string[] = [];
        const richiesta = (id: string, attesa: number) =>
            conContesto({ requestId: id, path: '/api/c' }, async () => {
                await new Promise((r) => setTimeout(r, attesa));
                visto.push(contesto()!.requestId);
            });
        await Promise.all([richiesta('A', 20), richiesta('B', 5), richiesta('C', 10)]);
        expect(visto.sort()).toEqual(['A', 'B', 'C']);
    });

    it('la guardia di rientranza impedisce la ricorsione del logger', async () => {
        await conContesto({ requestId: 'r4', path: '/api/w' }, async () => {
            expect(inLogger()).toBe(false);
            await entraNelLogger(async () => {
                expect(inLogger()).toBe(true);
            });
            expect(inLogger()).toBe(false);
        });
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-context.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa**

Crea `src/lib/logging/context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contesto della richiesta corrente, propagato implicitamente lungo la catena
 * async. Serve a correlare fra loro le righe della stessa richiesta (su Fluid
 * Compute più invocazioni condividono lo stesso processo Node, quindi il flusso
 * di log è intrecciato).
 *
 * REGOLE INDEROGABILI (Fluid Compute):
 *  - si entra SOLO con `als.run(...)`, MAI con `enterWith()` (contamina il
 *    contesto corrente e può colare su richieste successive);
 *  - MAI tenere userId/ruolo in variabili di modulo: due richieste concorrenti
 *    si sovrascriverebbero a vicenda. L'istanza di AsyncLocalStorage a livello
 *    di modulo va invece benissimo: è lo *store* a essere per-catena.
 *
 * Questo modulo importa `node:async_hooks`: NON deve essere importato dal
 * middleware (che gira su Edge) né da codice client. Se accade, `npm run build`
 * fallisce rumorosamente — ed è il comportamento voluto.
 */

export interface ContestoRichiesta {
    requestId: string;
    path: string;
    userId?: string;
    ruolo?: string;
    scuolaId?: string;
    /** Payload già VALIDATO e REDATTO, stampato solo se la richiesta fallisce. */
    payload?: Record<string, unknown>;
    /** Guardia di rientranza: impedisce che un errore del logger si rilogghi. */
    dentroIlLogger?: boolean;
}

const als = new AsyncLocalStorage<ContestoRichiesta>();

export function contesto(): ContestoRichiesta | undefined {
    return als.getStore();
}

export function conContesto<T>(
    iniziale: ContestoRichiesta,
    fn: () => Promise<T>
): Promise<T> {
    return als.run(iniziale, fn);
}

export function impostaUtente(u: { userId?: string; ruolo?: string; scuolaId?: string | null }): void {
    const s = als.getStore();
    if (!s) return;
    if (u.userId) s.userId = u.userId;
    if (u.ruolo) s.ruolo = u.ruolo;
    if (u.scuolaId) s.scuolaId = u.scuolaId;
}

/** Deposita il payload già validato e redatto. `dove` = 'body' | 'query' | 'params'. */
export function impostaPayload(dove: string, valore: unknown): void {
    const s = als.getStore();
    if (!s) return;
    s.payload = { ...(s.payload ?? {}), [dove]: valore };
}

export function inLogger(): boolean {
    return als.getStore()?.dentroIlLogger === true;
}

/**
 * Esegue una scrittura del logger marcando il contesto. Se durante questa
 * esecuzione il logger prova a loggare di nuovo (es. l'insert su app_log
 * fallisce), `inLogger()` è true e la seconda emissione viene scartata:
 * senza questa guardia si otterrebbe una ricorsione fino all'esaurimento
 * della memoria.
 */
export async function entraNelLogger<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const s = als.getStore();
    if (!s) return fn();
    if (s.dentroIlLogger) return undefined;
    s.dentroIlLogger = true;
    try {
        return await fn();
    } finally {
        s.dentroIlLogger = false;
    }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Comando: `npx vitest run __tests__/lib/logging-context.test.ts`
Atteso: PASS, 6 test verdi.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logging/context.ts __tests__/lib/logging-context.test.ts
git commit -m "feat(logging): contesto di richiesta con AsyncLocalStorage + guardia di rientranza"
```

---

## Task 4: Il logger (marker + logfmt)

**Files:**
- Create: `src/lib/logging/logger.ts`
- Test: `__tests__/lib/logging-logger.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-logger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formattaRiga, logOk, logErrore, logEvento, EVENTI_PERSISTITI } from '@/lib/logging/logger';

describe('formattaRiga — marker + logfmt', () => {
    it('mette il marker per primo e le coppie chiave=valore dopo', () => {
        expect(formattaRiga('KV_OK', { rid: 'abc', ms: 12 })).toBe('KV_OK rid=abc ms=12');
    });

    it('quota i valori con spazi o virgolette', () => {
        expect(formattaRiga('KV_ERR', { msg: 'colonna non trovata' }))
            .toBe('KV_ERR msg="colonna non trovata"');
    });

    it('omette i campi vuoti invece di scrivere undefined', () => {
        expect(formattaRiga('KV_OK', { rid: 'a', uid: undefined, ruolo: null }))
            .toBe('KV_OK rid=a');
    });

    it('il marker è un token alfanumerico (unica àncora affidabile per la ricerca full-text)', () => {
        expect(formattaRiga('KV_ERR', {}).split(' ')[0]).toMatch(/^[A-Z_]+$/);
    });
});

describe('logger — silenzio nei test', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('sotto vitest NON scrive nulla su console (VITEST è definita)', () => {
        logOk({ ms: 1 });
        logErrore({ operazione: 'x' }, new Error('boom'));
        logEvento('email', 'error', { provider: 'resend' });
        expect(log).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
    });
});

describe('allowlist degli eventi persistiti', () => {
    it('include gli eventi critici i cui SUCCESSI vanno in tabella', () => {
        for (const e of ['email', 'push', 'cron', 'fattura', 'pagamento']) {
            expect(EVENTI_PERSISTITI.has(e)).toBe(true);
        }
    });

    it('NON include gli eventi ad alto volume', () => {
        expect(EVENTI_PERSISTITI.has('route')).toBe(false);
        expect(EVENTI_PERSISTITI.has('db')).toBe(false);
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-logger.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa**

Crea `src/lib/logging/logger.ts`:

```ts
import { contesto } from './context';
import { descriviErrore, serializza } from './serialize';
import { redact } from './redact';
import { appLog } from './app-log';

/**
 * Emissione dei log.
 *
 * FORMATO: marker atomico + logfmt, NON JSON.
 * Vercel non parsa né indicizza il JSON dentro il messaggio: sul contenuto è
 * disponibile solo la ricerca full-text (`query`), e il tool MCP restituisce al
 * massimo 100 righe per chiamata. Quindi:
 *  - il marker (`KV_OK`, `KV_ERR`, …) è un token alfanumerico: è l'unica àncora
 *    che sopravvive con certezza alla tokenizzazione full-text;
 *  - si emettono 1-2 righe per richiesta, non dieci: un logger loquace ACCECA
 *    (100 righe = 10 richieste viste);
 *  - non si loggano metodo/path/status: Vercel li conosce già come metadati di
 *    piattaforma. Si logga solo ciò che Vercel NON sa.
 *
 * LIVELLI: solo console.log e console.error. `console.warn` NON produce il
 * livello `warning` nelle funzioni non-streaming: produce `error`, e
 * inquinerebbe il filtro.
 */

export type Livello = 'info' | 'warn' | 'error';
export type Valore = string | number | boolean | null | undefined;

/**
 * Guardia valutata UNA VOLTA al caricamento del modulo, non a ogni richiesta:
 * `__tests__/api/p0-gates.test.ts` stubba NODE_ENV a 'production' a runtime,
 * quindi NODE_ENV non è affidabile come discriminante.
 */
const SILENZIOSO =
    !!process.env.VITEST || process.env.KV_LOG_LEVEL === 'silent';

/** Eventi i cui SUCCESSI vengono persistiti (deroga a "solo warn+error in tabella"). */
export const EVENTI_PERSISTITI = new Set(['email', 'push', 'cron', 'fattura', 'pagamento', 'config']);

function quota(v: Valore): string {
    const s = String(v);
    return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function formattaRiga(marker: string, campi: Record<string, Valore>): string {
    const coppie = Object.entries(campi)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${quota(v)}`);
    return coppie.length ? `${marker} ${coppie.join(' ')}` : marker;
}

function campiDelContesto(): Record<string, Valore> {
    const c = contesto();
    if (!c) return {};
    return { rid: c.requestId, uid: c.userId, ruolo: c.ruolo, sede: c.scuolaId };
}

/** Riga di sintesi di una richiesta andata a buon fine. */
export function logOk(campi: { ms: number; rt?: string; n?: number }): void {
    if (SILENZIOSO) return;
    // eslint-disable-next-line no-console -- unico punto di scrittura su stdout
    console.log(formattaRiga('KV_OK', { ...campiDelContesto(), ...campi }));
}

/**
 * Errore. Emette DUE cose:
 *  1. la riga `KV_ERR` in logfmt, che io cerco con `query: "KV_ERR"`;
 *  2. l'Error NATIVO, perché lo stack completo e il raggruppamento automatico di
 *     Vercel (`get_runtime_errors` raggruppa per *error name*) funzionano solo
 *     con un vero Error. MAI `JSON.stringify(err)`: su un Error nativo restituisce
 *     `{}` — bug già presente nel repo in api/attendance/daily/route.ts.
 *
 * Il payload della richiesta (già redatto) viene stampato SOLO qui, nel ramo
 * d'errore: sul percorso felice non aggiunge nulla e moltiplicherebbe per 20 la
 * superficie di dati personali.
 */
export function logErrore(
    campi: { operazione: string; ms?: number; stato?: number; evento?: string },
    err: unknown
): void {
    const d = descriviErrore(err);
    const c = contesto();
    persisti({
        livello: 'error',
        evento: campi.evento ?? 'route',
        messaggio: d.messaggio,
        stack: d.stack,
        codice: d.codice,
        statoHttp: campi.stato,
        contestoExtra: { operazione: campi.operazione, payload: c?.payload },
    });
    if (SILENZIOSO) return;
    // eslint-disable-next-line no-console -- unico punto di scrittura su stderr
    console.error(
        formattaRiga('KV_ERR', {
            ...campiDelContesto(),
            op: campi.operazione,
            code: d.codice,
            stato: campi.stato,
            ms: campi.ms,
            digest: d.digest,
            msg: d.messaggio,
            payload: c?.payload ? serializza(c.payload, 800) : undefined,
        })
    );
    // eslint-disable-next-line no-console -- l'Error NATIVO: stack + clustering
    console.error(err instanceof Error ? err : new Error(d.messaggio));
}

/** Evento di dominio (email, push, cron, config, db, client…). */
export function logEvento(
    evento: string,
    livello: Livello,
    campi: Record<string, Valore>,
    err?: unknown
): void {
    const d = err === undefined ? undefined : descriviErrore(err);
    persisti({
        livello,
        evento,
        messaggio: d?.messaggio ?? String(campi.msg ?? evento),
        stack: d?.stack,
        codice: d?.codice ?? (campi.code === undefined ? undefined : String(campi.code)),
        contestoExtra: redact(campi) as Record<string, unknown>,
    });
    if (SILENZIOSO) return;
    const marker = livello === 'error' ? 'KV_ERR' : livello === 'warn' ? 'KV_WARN' : 'KV_EVT';
    const riga = formattaRiga(marker, { ...campiDelContesto(), evento, ...campi, msg: d?.messaggio ?? campi.msg });
    if (livello === 'error') {
        // eslint-disable-next-line no-console
        console.error(riga);
        if (err !== undefined) {
            // eslint-disable-next-line no-console
            console.error(err instanceof Error ? err : new Error(d!.messaggio));
        }
    } else {
        // eslint-disable-next-line no-console
        console.log(riga);
    }
}

/**
 * Persistenza su app_log. Fire-and-forget e MAI bloccante: un errore del logger
 * non deve far fallire la richiesta dell'utente.
 * Si persiste solo ciò che ha valore diagnostico oltre la retention di Vercel
 * (1 giorno sul piano Pro): warn/error, più i SUCCESSI degli eventi critici —
 * senza i quali "nessun log" continuerebbe a significare sia "tutto bene" sia
 * "non è mai partito niente".
 */
function persisti(riga: Parameters<typeof appLog>[0]): void {
    if (SILENZIOSO) return;
    const daPersistere =
        riga.livello === 'error' || riga.livello === 'warn' || EVENTI_PERSISTITI.has(riga.evento);
    if (!daPersistere) return;
    void appLog(riga);
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Il logger importa `./app-log`, che ancora non esiste. Crea prima un modulo minimo — verrà completato nel Task 8.

Crea `src/lib/logging/app-log.ts` (versione provvisoria):

```ts
export interface RigaLog {
    livello: 'info' | 'warn' | 'error';
    evento: string;
    messaggio: string;
    stack?: string;
    codice?: string;
    statoHttp?: number;
    sorgente?: 'server' | 'client';
    piattaforma?: 'web' | 'ios' | 'android';
    contestoExtra?: Record<string, unknown>;
}

/** Sostituito nel Task 8 dalla scrittura reale su Supabase. */
export async function appLog(_riga: RigaLog): Promise<void> {
    return;
}
```

Comando: `npx vitest run __tests__/lib/logging-logger.test.ts`
Atteso: PASS, 7 test verdi.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logging/logger.ts src/lib/logging/app-log.ts __tests__/lib/logging-logger.test.ts
git commit -m "feat(logging): logger marker+logfmt, silenzioso nei test"
```

---

## Task 5: `withRoute()` — il wrapper

**Files:**
- Create: `src/lib/logging/with-route.ts`
- Test: `__tests__/lib/logging-with-route.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-with-route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/logging/with-route';
import { contesto } from '@/lib/logging/context';

/**
 * I test API del repo passano una `Request` NUDA (non una NextRequest) e
 * invocano l'handler come funzione. Il wrapper deve essere trasparente.
 */
const req = (url = 'http://localhost/api/x', init?: RequestInit) => new Request(url, init);

describe('withRoute', () => {
    it('non altera lo status né il body della risposta', async () => {
        const GET = withRoute('x:GET', async () =>
            NextResponse.json({ ok: true, dato: 42 }, { status: 201 })
        );
        const res = await GET(req());
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ ok: true, dato: 42 });
    });

    it('lascia passare intatti i 500 ESPLICITI della route (non li intercetta)', async () => {
        const POST = withRoute('x:POST', async () =>
            NextResponse.json({ error: 'Errore nel salvataggio' }, { status: 500 })
        );
        const res = await POST(req());
        expect(res.status).toBe(500);
        expect((await res.json()).error).toContain('Errore nel salvataggio');
    });

    it('RILANCIA le eccezioni dopo averle loggate (non le inghiotte)', async () => {
        const GET = withRoute('x:GET', async () => { throw new Error('boom'); });
        await expect(GET(req())).rejects.toThrow('boom');
    });

    it('inoltra il secondo argomento (params delle route dinamiche) inalterato', async () => {
        const GET = withRoute(
            'x/[id]:GET',
            async (_r: Request, ctx: { params: Promise<{ id: string }> }) =>
                NextResponse.json({ id: (await ctx.params).id })
        );
        const res = await GET(req(), { params: Promise.resolve({ id: 'abc' }) });
        expect(await res.json()).toEqual({ id: 'abc' });
    });

    it('rende disponibile un requestId dentro l\'handler', async () => {
        let visto: string | undefined;
        const GET = withRoute('x:GET', async () => {
            visto = contesto()?.requestId;
            return NextResponse.json({});
        });
        await GET(req());
        expect(visto).toBeTruthy();
    });

    it('riusa l\'x-request-id iniettato dal middleware se è un uuid valido', async () => {
        const rid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
        let visto: string | undefined;
        const GET = withRoute('x:GET', async () => {
            visto = contesto()?.requestId;
            return NextResponse.json({});
        });
        await GET(req('http://localhost/api/x', { headers: { 'x-request-id': rid } }));
        expect(visto).toBe(rid);
    });

    it('IGNORA un x-request-id malformato (è spoofabile dal client)', async () => {
        let visto: string | undefined;
        const GET = withRoute('x:GET', async () => {
            visto = contesto()?.requestId;
            return NextResponse.json({});
        });
        await GET(req('http://localhost/api/x', { headers: { 'x-request-id': '<script>' } }));
        expect(visto).not.toBe('<script>');
        expect(visto).toBeTruthy();
    });

    it('NON consuma il body: la route può ancora leggerlo', async () => {
        const POST = withRoute('x:POST', async (r: Request) => {
            const body = await r.json();
            return NextResponse.json({ ricevuto: body });
        });
        const res = await POST(
            req('http://localhost/api/x', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'assenza' }),
                headers: { 'content-type': 'application/json' },
            })
        );
        expect(await res.json()).toEqual({ ricevuto: { tipo: 'assenza' } });
    });

    it('NON usa API solo-NextRequest (nextUrl/cookies): una Request nuda basta', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        await expect(GET(req())).resolves.toBeInstanceOf(Response);
    });

    it('espone x-request-id nella risposta, per correlare col log', async () => {
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        const res = await GET(req());
        expect(res.headers.get('x-request-id')).toBeTruthy();
    });

    it('il logger non tocca il DB nei test (nessuna chiamata di rete)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const GET = withRoute('x:GET', async () => NextResponse.json({}));
        await GET(req());
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-with-route.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa**

Crea `src/lib/logging/with-route.ts`:

```ts
import { conContesto } from './context';
import { logErrore, logOk } from './logger';

/**
 * Wrapper degli export delle route: SOLO osservabilità.
 *
 * Cosa NON fa, e perché:
 *  - NON assorbe i gate (`requireStaff`/`requireDocente`/`CRON_SECRET`) né zod:
 *    se quelle stringhe sparissero dal sorgente della route si romperebbero
 *    insieme il lock `__tests__/api/zod-coverage.test.ts` (in CI) e
 *    `scripts/audit-route-gates.mjs`, che li riconoscono per NOME TESTUALE.
 *  - NON legge né clona il body: le route fanno `await request.json()` dentro
 *    `parseBody`, e un doppio consumo dello stream romperebbe tutto. Clonarlo
 *    sarebbe peggio ancora: sulle 12 route multipart significherebbe duplicare
 *    in RAM uno ZIP o una foto da 20 MB. Il payload arriva dal contesto, dove lo
 *    deposita `parseBody` (Task 7).
 *  - NON usa API solo-`NextRequest` (`nextUrl`, `cookies`, `ip`): i ~90 test API
 *    passano una `Request` nuda.
 *  - NON inghiotte le eccezioni: le rilancia dopo averle loggate. Inghiottirle
 *    cambierebbe la semantica in produzione e romperebbe i test che asseriscono
 *    i 500 espliciti delle route.
 *
 * Uso:
 *   export const GET = withRoute('tasks:GET', async (request: NextRequest) => { … })
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

function nuovoRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `r${Math.random().toString(36).slice(2, 10)}`;
}

export function withRoute<A extends [Request, ...unknown[]]>(
    nome: string,
    handler: Handler<A>
): (...args: A) => Promise<Response> {
    return async (...args: A): Promise<Response> => {
        const request = args[0];

        // L'x-request-id in ingresso è spoofabile dal client: si accetta solo se
        // è un uuid valido (il middleware lo sovrascrive sempre), altrimenti se
        // ne genera uno nuovo. Le route invocate da cron/webhook, o dai test, non
        // hanno l'header: il fallback è obbligatorio.
        const entrante = request.headers?.get?.('x-request-id') ?? null;
        const requestId = entrante && UUID.test(entrante) ? entrante : nuovoRequestId();

        let path = '';
        try {
            path = new URL(request.url).pathname;
        } catch {
            /* url malformato: il log vale comunque */
        }

        const t0 = Date.now();
        return conContesto({ requestId, path }, async () => {
            try {
                const res = await handler(...args);
                const ms = Date.now() - t0;
                if (res.status >= 400) {
                    logErrore({ operazione: nome, ms, stato: res.status }, new Error(`http_${res.status}`));
                } else {
                    logOk({ ms, rt: nome });
                }
                try {
                    res.headers.set('x-request-id', requestId);
                } catch {
                    /* Response immutabile (raro): il log resta valido */
                }
                return res;
            } catch (err) {
                logErrore({ operazione: nome, ms: Date.now() - t0, stato: 500 }, err);
                throw err; // MAI inghiottire
            }
        });
    };
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Comando: `npx vitest run __tests__/lib/logging-with-route.test.ts`
Atteso: PASS, 11 test verdi.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logging/with-route.ts __tests__/lib/logging-with-route.test.ts
git commit -m "feat(logging): withRoute — osservabilità pura, non tocca body/gate/eccezioni"
```

---

## Task 6: `global.fetch` strumentato sui client Supabase

È il singolo innesto con il rapporto valore/costo più alto del piano: una riga per factory, e copre **225 route su 239** più Storage, RPC e Auth. Soprattutto, rende visibili le **73 scritture il cui `catch` non scatta mai** (PostgREST non lancia: ritorna `{ error }`).

**Files:**
- Modify: `src/lib/supabase/server-client.ts`
- Create: `src/lib/logging/supabase-fetch.ts`
- Test: `__tests__/lib/logging-supabase-fetch.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-supabase-fetch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analizzaBersaglio, creaFetchStrumentato } from '@/lib/logging/supabase-fetch';

describe('analizzaBersaglio — dall\'URL si ricava cosa stiamo facendo', () => {
    it('riconosce una tabella', () => {
        expect(analizzaBersaglio('https://x.supabase.co/rest/v1/alunni?select=*'))
            .toEqual({ area: 'db', nome: 'alunni' });
    });
    it('riconosce una RPC', () => {
        expect(analizzaBersaglio('https://x.supabase.co/rest/v1/rpc/app_log_registra'))
            .toEqual({ area: 'rpc', nome: 'app_log_registra' });
    });
    it('riconosce lo storage', () => {
        expect(analizzaBersaglio('https://x.supabase.co/storage/v1/object/protocolli/a.pdf').area)
            .toBe('storage');
    });
    it('riconosce l\'auth', () => {
        expect(analizzaBersaglio('https://x.supabase.co/auth/v1/token').area).toBe('auth');
    });
});

describe('creaFetchStrumentato', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('inoltra input e init INTATTI (signal e header preservati)', async () => {
        const base = vi.fn(async () => new Response('{}', { status: 200 }));
        const f = creaFetchStrumentato(base);
        const ac = new AbortController();
        const init = { method: 'POST', signal: ac.signal, headers: { 'x-y': '1' } };
        await f('https://x.supabase.co/rest/v1/alunni', init);
        expect(base).toHaveBeenCalledWith('https://x.supabase.co/rest/v1/alunni', init);
    });

    it('sulle risposte OK NON tocca il corpo (lo streaming dei download resta intatto)', async () => {
        const res = new Response('contenuto-binario', { status: 200 });
        const spia = vi.spyOn(res, 'clone');
        const f = creaFetchStrumentato(async () => res);
        const out = await f('https://x.supabase.co/storage/v1/object/x.pdf');
        expect(spia).not.toHaveBeenCalled();
        expect(await out.text()).toBe('contenuto-binario');
    });

    it('sugli errori legge il corpo E lo restituisce comunque leggibile al chiamante', async () => {
        const f = creaFetchStrumentato(async () =>
            new Response('{"code":"42P01","message":"relation does not exist"}', { status: 404 })
        );
        const out = await f('https://x.supabase.co/rest/v1/inesistente');
        expect(out.status).toBe(404);
        // il corpo NON deve essere stato consumato per il chiamante
        expect(await out.json()).toEqual({ code: '42P01', message: 'relation does not exist' });
    });

    it('rilancia gli errori di rete (AbortError incluso: postgrest lo tratta a parte)', async () => {
        const f = creaFetchStrumentato(async () => { throw new DOMException('abort', 'AbortError'); });
        await expect(f('https://x.supabase.co/rest/v1/alunni')).rejects.toThrow();
    });

    it('non lancia mai per colpa propria (fail-open su URL malformato)', async () => {
        const f = creaFetchStrumentato(async () => new Response('{}', { status: 200 }));
        await expect(f('non-un-url')).resolves.toBeInstanceOf(Response);
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-supabase-fetch.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa il fetch strumentato**

Crea `src/lib/logging/supabase-fetch.ts`:

```ts
import { logEvento } from './logger';
import { inLogger } from './context';

/**
 * Fetch strumentato per i client Supabase.
 *
 * Perché QUI e non con un Proxy sul client: `.from('t').select()` NON ritorna
 * `this`, ritorna un oggetto nuovo (`new PostgrestFilterBuilder`), quindi un
 * Proxy applicato a `.from()` muore al primo `.select()`. `{ global: { fetch } }`
 * è invece l'opzione UFFICIALE di supabase-js e `@supabase/ssr` la preserva:
 * un solo punto di intercettazione copre REST + RPC + Storage + Auth + Functions.
 *
 * INVARIANTE: una risposta PostgREST con `!res.ok` produce SEMPRE un log di
 * livello error, anche se il codice applicativo la ignora. È questo che rende
 * finalmente visibili le 73 scritture "fire-and-forget" del repo, i cui
 * `catch (err)` non scattano mai (PostgREST non lancia: ritorna `{ error }`).
 */

type Fetch = typeof fetch;

const LENTA_MS = 500;
const CORPO_ERRORE_MAX = 500;

export interface Bersaglio {
    area: 'db' | 'rpc' | 'storage' | 'auth' | 'altro';
    nome: string;
}

export function analizzaBersaglio(url: string): Bersaglio {
    try {
        const { pathname } = new URL(url);
        if (pathname.startsWith('/rest/v1/rpc/')) return { area: 'rpc', nome: pathname.slice(13) };
        if (pathname.startsWith('/rest/v1/')) return { area: 'db', nome: pathname.slice(9) };
        if (pathname.startsWith('/storage/v1/')) return { area: 'storage', nome: pathname.slice(12) };
        if (pathname.startsWith('/auth/v1/')) return { area: 'auth', nome: pathname.slice(9) };
        return { area: 'altro', nome: pathname };
    } catch {
        return { area: 'altro', nome: '?' };
    }
}

function urlDi(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

export function creaFetchStrumentato(base: Fetch = fetch): Fetch {
    return async (input, init) => {
        // Se siamo dentro il logger (es. la scrittura su app_log), non si logga:
        // altrimenti un errore di scrittura dei log genererebbe un log di errore
        // che tenta di scrivere i log → ricorsione fino all'esaurimento memoria.
        if (inLogger()) return base(input, init);

        const url = urlDi(input);
        const { area, nome } = analizzaBersaglio(url);
        const metodo = (init?.method ?? 'GET').toUpperCase();
        const t0 = Date.now();

        try {
            const res = await base(input, init); // args INTATTI: signal, priority, headers
            const ms = Date.now() - t0;

            if (!res.ok) {
                // Solo nel ramo d'errore si legge il corpo (JSON piccolo). MAI sulle
                // risposte ok: `storage.download()` passa da qui, e leggerne il corpo
                // distruggerebbe lo streaming e farebbe esplodere la memoria.
                let corpo = '';
                try {
                    corpo = (await res.clone().text()).slice(0, CORPO_ERRORE_MAX);
                } catch {
                    /* corpo illeggibile: resta lo status */
                }
                logEvento('db', 'error', {
                    area, nome, metodo, stato: res.status, ms, corpo,
                });
                return res;
            }

            if (ms > LENTA_MS) {
                logEvento('db', 'warn', { area, nome, metodo, stato: res.status, ms, lenta: true });
            }
            return res;
        } catch (err) {
            logEvento('db', 'error', { area, nome, metodo, ms: Date.now() - t0 }, err);
            throw err; // RILANCIARE sempre: postgrest tratta AbortError in modo speciale
        }
    };
}
```

> Nota: `res.clone()` è sicuro **solo** nel ramo `!res.ok` (corpo piccolo, sempre consumato subito). Non va mai usato sulle risposte ok.

- [ ] **Step 4: Aggancia il fetch ai client Supabase**

Modifica `src/lib/supabase/server-client.ts`. Aggiungi in testa:

```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './public-config'
import { creaFetchStrumentato } from '@/lib/logging/supabase-fetch'

/**
 * Il fetch strumentato è passato a TUTTI i factory, non solo a createAdminClient:
 * `createClient()` (session) è quello usato da `resolveIdentity()`, cioè dal gate
 * di autenticazione stesso. Strumentare solo l'admin client significherebbe non
 * vedere mai le query che rompono i login.
 */
const fetchStrumentato = creaFetchStrumentato()
```

Poi aggiungi `global: { fetch: fetchStrumentato },` come prima opzione dell'oggetto passato a `createServerClient` in **`createClient`**, **`createSessionClient`** e **`createAdminClient`**. Esempio su `createAdminClient`:

```ts
export async function createAdminClient() {
  return createServerClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: { fetch: fetchStrumentato },
      cookies: {
        getAll() { return [] },
        setAll() { },
      },
    }
  )
}
```

Infine aggiungi in fondo al file il client **non strumentato** del sink:

```ts
/**
 * Client dedicato alla scrittura dei LOG. È l'unico SENZA fetch strumentato:
 * se lo avesse, un errore di scrittura su `app_log` genererebbe un log di errore
 * che tenta di scrivere su `app_log` → ricorsione infinita.
 */
export async function createLogClient() {
  return createServerClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() { },
      },
    }
  )
}
```

- [ ] **Step 5: Aggiungi il test di regressione sull'opzione `global.fetch`**

`@supabase/ssr` oggi preserva `global.fetch` perché fa `{ ...options?.global, headers: {...} }`. Se un futuro major lo sovrascrivesse, l'opzione verrebbe persa **in silenzio**. Questo test lo impedisce.

Aggiungi in fondo a `__tests__/lib/logging-supabase-fetch.test.ts`:

```ts
import { createAdminClient } from '@/lib/supabase/server-client';

describe('regressione: @supabase/ssr deve PRESERVARE global.fetch', () => {
    it('il fetch custom viene davvero invocato dal client', async () => {
        const spia = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        );
        const supabase = await createAdminClient();
        await supabase.from('utenti').select('id').limit(1);
        expect(spia).toHaveBeenCalled();
        const chiamata = String(spia.mock.calls[0][0]);
        expect(chiamata).toContain('/rest/v1/utenti');
        spia.mockRestore();
    });
});
```

- [ ] **Step 6: Esegui i test**

Comando: `npx vitest run __tests__/lib/logging-supabase-fetch.test.ts`
Atteso: PASS, 10 test verdi.

- [ ] **Step 7: Verifica che l'intera suite non sia regredita**

Comando: `npx vitest run`
Atteso: tutti verdi (il fetch strumentato è silenzioso sotto vitest e non tocca la rete).

- [ ] **Step 8: Commit**

```bash
git add src/lib/logging/supabase-fetch.ts src/lib/supabase/server-client.ts __tests__/lib/logging-supabase-fetch.test.ts
git commit -m "feat(logging): fetch strumentato su tutti i client Supabase (DB, RPC, Storage, Auth)"
```

---

## Task 7: Payload nel contesto (senza toccare il body) e identità dai gate

**Files:**
- Modify: `src/lib/validation/http.ts`
- Modify: `src/lib/auth/require-staff.ts`
- Test: `__tests__/lib/logging-payload.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-payload.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { conContesto, contesto } from '@/lib/logging/context';

describe('il payload validato finisce nel contesto, già redatto', () => {
    it('parseBody deposita il body REDATTO', async () => {
        const schema = z.object({ tipo: z.string(), note: z.string() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x', {
                method: 'POST',
                body: JSON.stringify({ tipo: 'assenza', note: 'ha la febbre' }),
                headers: { 'content-type': 'application/json' },
            });
            const out = await parseBody(req, schema);
            expect('data' in out).toBe(true);
            const p = contesto()?.payload?.body as Record<string, string>;
            expect(p.tipo).toBe('assenza');            // allowlist → in chiaro
            expect(p.note).toBe('[redatto:str/12]');   // testo libero → redatto
        });
    });

    it('parseQuery deposita la query REDATTA', async () => {
        const schema = z.object({ userId: z.string() });
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            const req = new Request('http://localhost/api/x?userId=3f2504e0-4f89-11d3-9a0c-0305e82c3301');
            parseQuery(req, schema);
            const p = contesto()?.payload?.query as Record<string, string>;
            expect(p.userId).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301'); // uuid → in chiaro
        });
    });

    it('fuori da una richiesta non lancia', async () => {
        const schema = z.object({ a: z.string() });
        const req = new Request('http://localhost/api/x?a=1');
        expect(() => parseQuery(req, schema)).not.toThrow();
    });

    it('il body resta leggibile per la route (non viene consumato due volte)', async () => {
        const schema = z.object({ tipo: z.string() });
        const req = new Request('http://localhost/api/x', {
            method: 'POST',
            body: JSON.stringify({ tipo: 'assenza' }),
            headers: { 'content-type': 'application/json' },
        });
        const out = await parseBody(req, schema);
        expect(out).toEqual({ data: { tipo: 'assenza' } });
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-payload.test.ts`
Atteso: FAIL — `contesto()?.payload` è `undefined`.

- [ ] **Step 3: Deposita il payload in `validation/http.ts`**

Modifica `src/lib/validation/http.ts`. Aggiungi gli import in testa:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { impostaPayload } from '@/lib/logging/context';
import { redact } from '@/lib/logging/redact';
```

Poi, dentro `parseBody`, dopo il parsing riuscito, e dentro `parseQuery`, deposita il valore. Sostituisci il corpo delle due funzioni:

```ts
export async function parseBody<S extends z.ZodType>(
    request: Request,
    schema: S
): Promise<ParseResult<z.output<S>>> {
    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return {
            response: validationError([
                { path: [], message: 'Body JSON mancante o malformato' },
            ]),
        };
    }
    // Il payload REDATTO viene depositato nel contesto: il wrapper `withRoute` lo
    // stamperà SOLO se la richiesta fallisce. Così il body non viene mai letto due
    // volte (che romperebbe le route) né clonato (che farebbe esplodere la memoria
    // sulle route multipart).
    impostaPayload('body', redact(raw));
    return parseData(schema, raw);
}

export function parseQuery<S extends z.ZodType>(
    request: Request,
    schema: S
): ParseResult<z.output<S>> {
    const { searchParams } = new URL(request.url);
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(searchParams.keys())) {
        const values = searchParams.getAll(key);
        query[key] = values.length > 1 ? values : values[0];
    }
    impostaPayload('query', redact(query));
    return parseData(schema, query);
}
```

- [ ] **Step 4: Scrivi l'identità nel contesto dai gate**

Modifica `src/lib/auth/require-staff.ts`. Aggiungi l'import:

```ts
import { impostaUtente } from '@/lib/logging/context'
import { logEvento } from '@/lib/logging/logger'
```

Sostituisci il `console.warn` del fallback legacy (riga ~102) con il logger strutturato:

```ts
      logEvento('auth', 'warn', { motivo: 'header-fallback', path })
      return { userId: headerId, source: 'header' }
```

E aggiungi `impostaUtente(...)` subito prima di ogni `return { user }` nei quattro gate (`requireStaff`, `requireKitchenRead`, `requireUser`, `requireDocente`). Esempio su `requireStaff`:

```ts
  impostaUtente({ userId: user.id, ruolo: user.role, scuolaId: user.scuola_id })
  return { user }
```

Aggiungi anche il log dei dinieghi, prima dei `return { response: ... }` con 403:

```ts
    logEvento('auth', 'warn', { motivo: 'ruolo-negato', ruolo: user?.role ?? 'sconosciuto', gate: 'requireStaff' })
```

> `logEvento('auth', 'warn', …)` è di livello warn: finisce in tabella. I 401/403 sono frequentissimi (sessione scaduta): se il volume risulta rumoroso al collaudo H, si declassa a `info` — che finisce solo su Vercel e non in tabella.

- [ ] **Step 5: Aggiorna il test che asseriva il vecchio `console.warn`**

`__tests__/lib/resolveIdentity.test.ts:97-99` asserisce `expect(warn).toHaveBeenCalledWith(expect.stringContaining('[auth][header-fallback]'))`. Ora quel percorso non usa più `console.warn`.

Apri `__tests__/lib/resolveIdentity.test.ts` e sostituisci l'assertion sul `console.warn` con una che verifica il comportamento vero (l'identità viene comunque risolta dall'header):

```ts
        // Il fallback legacy ora passa dal logger strutturato (evento 'auth',
        // motivo 'header-fallback'), che è silenzioso sotto vitest: qui si
        // verifica il COMPORTAMENTO, non l'effetto collaterale sul console.
        expect(out).toEqual({ userId: 'u-legacy', source: 'header' });
```

(adatta il valore atteso a quello già usato dal test).

- [ ] **Step 6: Esegui i test**

Comando: `npx vitest run __tests__/lib/logging-payload.test.ts __tests__/lib/resolveIdentity.test.ts`
Atteso: PASS.

- [ ] **Step 7: Esegui l'intera suite**

Comando: `npx vitest run`
Atteso: tutti verdi.

- [ ] **Step 8: Commit**

```bash
git add src/lib/validation/http.ts src/lib/auth/require-staff.ts __tests__/lib/logging-payload.test.ts __tests__/lib/resolveIdentity.test.ts
git commit -m "feat(logging): payload redatto nel contesto + identità e dinieghi dai gate"
```

---

## Task 8: Tabella `app_log` e sink su Supabase

**Files:**
- Create: `supabase/migrations/20260713090000_app_log.sql`
- Rewrite: `src/lib/logging/app-log.ts`
- Test: `__tests__/lib/logging-app-log.test.ts`

- [ ] **Step 1: Scrivi la migrazione**

Crea `supabase/migrations/20260713090000_app_log.sql`:

```sql
-- app_log — log applicativo persistito (warn/error + successi degli eventi critici).
--
-- Retention: 30 giorni (i Runtime Logs di Vercel durano 1 giorno sul piano Pro:
-- questa tabella è la memoria lunga).
--
-- RLS: DENY-ALL, solo service_role. NOTA: NON si replica il pattern di
-- audit_scritture_docente / fea_audit_log, che hanno una policy
-- `FOR SELECT TO authenticated USING (true)` e sono quindi leggibili da QUALSIASI
-- utente loggato, genitori compresi. Per i log non è ammissibile.
--
-- Il job di purge va schedulato una volta in produzione (pg_cron è già attivo):
--   select cron.schedule('app-log-purge', '30 3 * * *', $$ select public.app_log_purge(); $$);

create table if not exists public.app_log (
    id               uuid primary key default gen_random_uuid(),
    creato_il        timestamptz not null default now(),
    livello          text        not null check (livello in ('info', 'warn', 'error')),
    evento           text        not null,
    sorgente         text        not null default 'server' check (sorgente in ('server', 'client')),
    messaggio        text        not null,
    stack            text,
    codice           text,
    route            text,
    stato_http       integer,
    -- SENZA foreign key: il log deve sopravvivere all'oblio GDPR dell'utente.
    utente_id        uuid,
    utente_ruolo     text,
    scuola_id        uuid,
    request_id       text,
    piattaforma      text        check (piattaforma in ('web', 'ios', 'android')),
    app_versione     text,
    ambiente         text,
    -- Dedup: righe identiche si sommano invece di moltiplicarsi.
    fingerprint      text        not null,
    occorrenze       integer     not null default 1,
    visto_la_prima   timestamptz not null default now(),
    visto_l_ultima   timestamptz not null default now(),
    contesto         jsonb       not null default '{}'::jsonb
);

create unique index if not exists app_log_fingerprint_key on public.app_log (fingerprint);
create index if not exists app_log_creato_il_idx on public.app_log (creato_il desc);
create index if not exists app_log_livello_idx    on public.app_log (livello, visto_l_ultima desc);
create index if not exists app_log_evento_idx     on public.app_log (evento, visto_l_ultima desc);
create index if not exists app_log_utente_idx     on public.app_log (utente_id, visto_l_ultima desc);
create index if not exists app_log_route_idx      on public.app_log (route, visto_l_ultima desc);
create index if not exists app_log_request_idx    on public.app_log (request_id) where request_id is not null;

alter table public.app_log enable row level security;

drop policy if exists "service app_log" on public.app_log;
create policy "service app_log" on public.app_log
    to service_role using (true) with check (true);

grant all on public.app_log to service_role;
-- Il baseline concede ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated: la RLS basterebbe, ma il REVOKE è la cintura di sicurezza nel
-- caso in cui un domani qualcuno aggiunga per sbaglio una policy permissiva.
revoke all on public.app_log from anon, authenticated;

-- Registrazione con dedup: una riga già vista incrementa il contatore.
create or replace function public.app_log_registra(righe jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    r jsonb;
    n integer := 0;
begin
    for r in select * from jsonb_array_elements(righe)
    loop
        insert into public.app_log (
            livello, evento, sorgente, messaggio, stack, codice, route, stato_http,
            utente_id, utente_ruolo, scuola_id, request_id, piattaforma,
            app_versione, ambiente, fingerprint, contesto
        )
        values (
            r->>'livello',
            r->>'evento',
            coalesce(r->>'sorgente', 'server'),
            left(coalesce(r->>'messaggio', ''), 1000),
            left(r->>'stack', 4000),
            left(r->>'codice', 60),
            left(r->>'route', 300),
            nullif(r->>'stato_http', '')::integer,
            nullif(r->>'utente_id', '')::uuid,
            left(r->>'utente_ruolo', 40),
            nullif(r->>'scuola_id', '')::uuid,
            left(r->>'request_id', 120),
            r->>'piattaforma',
            left(r->>'app_versione', 40),
            left(r->>'ambiente', 20),
            r->>'fingerprint',
            coalesce(r->'contesto', '{}'::jsonb)
        )
        on conflict (fingerprint) do update
            set occorrenze     = public.app_log.occorrenze + 1,
                visto_l_ultima = now();
        n := n + 1;
    end loop;
    return n;
end;
$$;

revoke execute on function public.app_log_registra(jsonb) from public, anon, authenticated;
grant execute on function public.app_log_registra(jsonb) to service_role;

-- Purge a LOTTI: un DELETE secco su milioni di righe bloccherebbe la tabella e
-- gonfierebbe i backup.
create or replace function public.app_log_purge()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    tot integer := 0;
    n   integer;
begin
    loop
        delete from public.app_log
        where id in (
            select id from public.app_log
            where visto_l_ultima < now() - interval '30 days'
            limit 10000
        );
        get diagnostics n = row_count;
        tot := tot + n;
        exit when n = 0;
    end loop;
    return tot;
end;
$$;

revoke execute on function public.app_log_purge() from public, anon, authenticated;
grant execute on function public.app_log_purge() to service_role;

-- pg_cron non esiste sul DB E2E della CI: la migrazione non deve rompersi lì.
do $$
begin
    perform cron.schedule('app-log-purge', '30 3 * * *', $cron$ select public.app_log_purge(); $cron$);
exception when others then null;
end $$;
```

- [ ] **Step 2: Scrivi il test del sink**

Crea `__tests__/lib/logging-app-log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fingerprintDi, SCHEMA_MANCANTE } from '@/lib/logging/app-log';

describe('fingerprint — righe identiche si sommano invece di moltiplicarsi', () => {
    it('è stabile per stesso evento + messaggio + testa dello stack', () => {
        const a = fingerprintDi({ livello: 'error', evento: 'route', messaggio: 'boom', stack: 'Error: boom\n at f1\n at f2' });
        const b = fingerprintDi({ livello: 'error', evento: 'route', messaggio: 'boom', stack: 'Error: boom\n at f1\n at f2\n at f9' });
        expect(a).toBe(b); // i frame oltre i primi 3 non contano
    });

    it('distingue messaggi diversi', () => {
        const a = fingerprintDi({ livello: 'error', evento: 'route', messaggio: 'boom' });
        const b = fingerprintDi({ livello: 'error', evento: 'route', messaggio: 'crack' });
        expect(a).not.toBe(b);
    });
});

describe('degradazione sul DB della CI (che non viene mai migrato)', () => {
    it('riconosce i codici di tabella/colonna assente', () => {
        for (const c of ['42P01', '42703', 'PGRST204', 'PGRST205']) {
            expect(SCHEMA_MANCANTE.has(c)).toBe(true);
        }
    });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-app-log.test.ts`
Atteso: FAIL — `fingerprintDi` non esiste.

- [ ] **Step 4: Riscrivi `src/lib/logging/app-log.ts`**

```ts
import { createHash } from 'node:crypto';
import { contesto, entraNelLogger } from './context';

/**
 * Sink su Supabase. Regole:
 *  - MAI bloccante, MAI lancia: un errore del logger non deve far fallire la
 *    richiesta dell'utente (stesso contratto di src/lib/audit/scrittura.ts);
 *  - MAI ricorsivo: usa `createLogClient()`, l'unico client SENZA fetch
 *    strumentato, e la guardia `entraNelLogger`;
 *  - degrada in silenzio se la tabella non esiste. Il DB usato dagli E2E in CI è
 *    un progetto Supabase SEPARATO che non viene mai migrato: senza il
 *    circuit-breaker qui sotto, ogni log tenterebbe un insert destinato a fallire.
 *
 * NOTA sull'import DINAMICO di `createLogClient` (dentro appLog, non in testa):
 * server-client.ts importa il fetch strumentato, che importa il logger, che
 * importa questo modulo. Un import statico chiuderebbe il ciclo
 * logger → app-log → server-client → supabase-fetch → logger. Le funzioni sono
 * hoisted e il ciclo si risolverebbe comunque, ma è fragile: l'import dinamico
 * lo spezza al caricamento del modulo, che è quando i cicli fanno danni.
 */

export const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205']);

/** Circuit-breaker per-lambda: si prova UNA volta, poi si smette. */
let tabellaAssente = false;

export interface RigaLog {
    livello: 'info' | 'warn' | 'error';
    evento: string;
    messaggio: string;
    stack?: string;
    codice?: string;
    statoHttp?: number;
    sorgente?: 'server' | 'client';
    piattaforma?: 'web' | 'ios' | 'android';
    utenteId?: string;
    utenteRuolo?: string;
    scuolaId?: string;
    requestId?: string;
    route?: string;
    contestoExtra?: Record<string, unknown>;
}

/** Le righe identiche si sommano: il moltiplicatore di volume è il client. */
export function fingerprintDi(r: Pick<RigaLog, 'livello' | 'evento' | 'messaggio' | 'stack'>): string {
    const testa = (r.stack ?? '').split('\n').slice(0, 4).join('\n');
    return createHash('sha256')
        .update(`${r.livello}|${r.evento}|${r.messaggio}|${testa}`)
        .digest('hex')
        .slice(0, 32);
}

function tabellaMancante(err: { code?: string; message?: string } | null): boolean {
    if (!err) return false;
    if (err.code && SCHEMA_MANCANTE.has(err.code)) return true;
    // PostgREST non sempre popola `code`: fallback testuale (stesso pattern di
    // src/app/api/notifiche/promemoria/route.ts).
    return /does not exist|schema cache|could not find/i.test(err.message ?? '');
}

export async function appLog(riga: RigaLog): Promise<void> {
    if (tabellaAssente) return;
    const c = contesto();

    const record = {
        livello: riga.livello,
        evento: riga.evento,
        sorgente: riga.sorgente ?? 'server',
        messaggio: riga.messaggio,
        stack: riga.stack ?? null,
        codice: riga.codice ?? null,
        route: riga.route ?? c?.path ?? null,
        stato_http: riga.statoHttp ?? null,
        utente_id: riga.utenteId ?? c?.userId ?? null,
        utente_ruolo: riga.utenteRuolo ?? c?.ruolo ?? null,
        scuola_id: riga.scuolaId ?? c?.scuolaId ?? null,
        request_id: riga.requestId ?? c?.requestId ?? null,
        piattaforma: riga.piattaforma ?? 'web',
        app_versione: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
        ambiente: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
        fingerprint: fingerprintDi(riga),
        contesto: riga.contestoExtra ?? {},
    };

    await entraNelLogger(async () => {
        try {
            // Import dinamico: spezza il ciclo con server-client (vedi nota in testa).
            const { createLogClient } = await import('@/lib/supabase/server-client');
            const supabase = await createLogClient();
            const { error } = await supabase.rpc('app_log_registra', { righe: [record] });
            if (error && tabellaMancante(error)) {
                tabellaAssente = true; // degrade: DB della CI non migrato
                return;
            }
            // Nessun ri-log in caso di errore: siamo dentro entraNelLogger, e
            // rilanciare qui creerebbe la ricorsione che vogliamo evitare.
        } catch {
            /* best-effort: il logging non fa mai fallire la richiesta */
        }
    });
}

/** Solo per i test. */
export function resetBreaker(): void {
    tabellaAssente = false;
}
```

- [ ] **Step 5: Esegui i test**

Comando: `npx vitest run __tests__/lib/logging-app-log.test.ts`
Atteso: PASS.

- [ ] **Step 6: Applica la migrazione al DB di produzione via MCP Supabase**

Usa `mcp__supabase__apply_migration` con `name: "app_log"` e il contenuto SQL del passo 1.
Poi verifica con `mcp__supabase__execute_sql`:

```sql
select count(*) from public.app_log;
select jobname from cron.job where jobname = 'app-log-purge';
```

Atteso: `0` righe, e il job `app-log-purge` presente.
Infine `mcp__supabase__get_advisors` con `type: "security"` → **0 ERROR**.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260713090000_app_log.sql src/lib/logging/app-log.ts __tests__/lib/logging-app-log.test.ts
git commit -m "feat(logging): tabella app_log (RLS deny-all) + dedup + purge 30gg"
```

---

## Task 9: `src/instrumentation.ts` — rete di sicurezza server e preflight

**Files:**
- Create: `src/instrumentation.ts`
- Modify: `next.config.ts` (solo commento-lock)

- [ ] **Step 1: Crea il file**

**Attenzione alla posizione**: il file va in `src/`, **non** nella radice. Next calcola la cartella di scansione come `dirname(appDir)`, e qui `appDir = src/app` → scandisce solo `src/`. Un `instrumentation.ts` nella radice viene **ignorato senza errori né warning**: sembra a posto e non logga niente.

Crea `src/instrumentation.ts`:

```ts
import type { Instrumentation } from 'next';

/**
 * Eseguita una volta per processo E per runtime (Node + Edge), a ogni cold start.
 * Il file è bundlato anche per l'edge (serve al middleware): qualunque import
 * Node-only a livello di modulo romperebbe la build del middleware.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    // Preflight della configurazione. Una variabile critica assente in produzione
    // è un INCIDENTE, non una nota: per mesi le email di credenziali non sono mai
    // partite e il sistema stampava un rassicurante console.log di livello info.
    const CRITICHE = [
        'SUPABASE_SERVICE_ROLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL',
        'RESEND_API_KEY',
        'OTP_FROM_EMAIL',
        'CRON_SECRET',
    ];
    const mancanti = CRITICHE.filter((k) => !process.env[k]);
    if (mancanti.length && process.env.VERCEL_ENV === 'production') {
        const { logEvento } = await import('@/lib/logging/logger');
        for (const k of mancanti) {
            logEvento('config', 'error', { mancante: k, ambiente: process.env.VERCEL_ENV });
        }
    }
}

/**
 * Rete di sicurezza: cattura ciò che `withRoute` per costruzione NON può vedere —
 * errori di rendering di pagine e Server Component, Server Action, middleware, e
 * gli errori sollevati FUORI dall'handler (parsing del body, risoluzione dei
 * params, serializzazione della Response).
 *
 * È complementare, non ridondante: `onRequestError` NON vede gli errori che
 * `withRoute` cattura e trasforma in una Response. Il conteggio degli `unhandled`
 * è quindi una metrica di qualità che deve tendere a zero.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
    try {
        const { descriviErrore, serializza } = await import('@/lib/logging/serialize');
        const { formattaRiga } = await import('@/lib/logging/logger');
        const d = descriviErrore(err);

        // `request.path` è `req.url`: contiene la QUERY STRING (quindi ?userId=,
        // ?token=…). Va troncato. `request.headers` contiene i cookie di sessione:
        // si usa una allowlist, mai l'oggetto intero.
        const path = request.path.split('?')[0];
        const h = request.headers;
        const prendi = (k: string) => {
            const v = h[k];
            return Array.isArray(v) ? v[0] : v;
        };

        // eslint-disable-next-line no-console -- rete di sicurezza: deve funzionare sempre
        console.error(
            formattaRiga('KV_ERR', {
                evento: 'unhandled',
                rid: prendi('x-request-id'),
                uid: prendi('x-kv-user'),
                metodo: request.method,
                path,
                rt: context.routePath,
                tipo: context.routeType,
                digest: d.digest,
                runtime: process.env.NEXT_RUNTIME,
                msg: d.messaggio,
            })
        );
        // eslint-disable-next-line no-console -- l'Error nativo: stack + clustering Vercel
        console.error(err instanceof Error ? err : new Error(serializza(err, 300)));
    } catch {
        /* se il logger d'emergenza fallisce, non c'è niente da fare: mai lanciare */
    }
};
```

- [ ] **Step 2: Metti il commento-lock in `next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ⚠️ NON aggiungere `compiler: { removeConsole: true }`.
  // Tutto il sistema di logging (src/lib/logging/**, src/instrumentation.ts)
  // scrive su console: rimuoverli in produzione farebbe sparire l'intera
  // osservabilità in silenzio. Vedi docs/superpowers/specs/2026-07-12-logging-strutturato-design.md
};

export default nextConfig;
```

- [ ] **Step 3: Verifica che la build passi**

Comando: `npm run build`
Atteso: build ok. Nell'output deve comparire che l'instrumentation hook è stato raccolto (nessun warning su `experimental.instrumentationHook`, che in Next 16 è deprecato e **non va aggiunto**).

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts next.config.ts
git commit -m "feat(logging): instrumentation server (onRequestError + preflight config)"
```

---

## Task 10: `x-request-id` nel middleware

**Files:**
- Modify: `src/middleware.ts`

- [ ] **Step 1: Modifica il middleware**

Il middleware gira su Edge ed è un'**invocazione separata** dalla route: nessuna catena async li collega, quindi il contesto non può attraversarli. L'unica cosa che passa è un header.

Attenzione al pattern `@supabase/ssr`: la response viene **ricreata** dentro `setAll`, e `request.cookies.set()` riscrive l'header `cookie`. Gli header vanno quindi ricostruiti **dopo**, e re-iniettati in entrambi i punti.

Sostituisci `src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { shouldRedirect } from '@/lib/auth/middleware-rules';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase/public-config';

export async function middleware(request: NextRequest) {
  // Correlation id di richiesta. Generato QUI e SEMPRE sovrascritto: un
  // x-request-id fornito dal client è spoofabile e non va mai creduto.
  // Il middleware non può creare il contesto AsyncLocalStorage (gira su Edge, in
  // un'invocazione separata dalla route): può solo passare l'header.
  const requestId = crypto.randomUUID();

  const conRequestId = () => {
    // `new Headers(request.headers)` va costruito DOPO gli eventuali
    // request.cookies.set() di supabase, che riscrivono l'header `cookie`.
    const headers = new Headers(request.headers);
    headers.set('x-request-id', requestId);
    return NextResponse.next({ request: { headers } });
  };

  let response = conRequestId();

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = conRequestId();
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // IMPORTANTE: non eseguire codice tra createServerClient e getUser (refresh).
  const { data: { user } } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  if (shouldRedirect(pathname, !!user)) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    url.searchParams.set('next', pathname);
    // NextResponse.redirect() non accetta `request: { headers }`: sul ramo di
    // redirect l'header non viaggia a valle. Si logga qui, perché "l'utente
    // buttato fuori a caso" è la classe di bug più fastidiosa e oggi è invisibile.
    // eslint-disable-next-line no-console -- Edge runtime: nessun logger Node disponibile
    console.log(`KV_EVT evento=auth motivo=redirect-login rid=${requestId} path=${pathname}`);
    return NextResponse.redirect(url);
  }

  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)',
  ],
};
```

- [ ] **Step 2: Verifica la build (il middleware gira su Edge: nessun import Node deve finirci)**

Comando: `npm run build`
Atteso: build ok. Se comparisse un errore su `node:async_hooks`, significa che il middleware sta importando (anche transitivamente) `src/lib/logging/context.ts`: va rimosso l'import.

- [ ] **Step 3: Esegui i test del middleware**

Comando: `npx vitest run __tests__/lib`
Atteso: tutti verdi.

- [ ] **Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat(logging): x-request-id generato dal middleware + log dei redirect a login"
```

---

## Task 11: `externalFetch` — il corpo dell'errore del provider non si butta più via

**Files:**
- Create: `src/lib/logging/external.ts`
- Modify: `src/lib/push/native-push.ts`
- Test: `__tests__/lib/logging-external.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `__tests__/lib/logging-external.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { externalFetch } from '@/lib/logging/external';

describe('externalFetch — il corpo dell\'errore è obbligatorio', () => {
    it('su !ok restituisce lo status E il corpo del provider', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('{"message":"The kidville.it domain is not verified"}', { status: 403 })
        );
        const r = await externalFetch('resend', 'https://api.resend.com/emails', { method: 'POST' });
        expect(r.ok).toBe(false);
        expect(r.stato).toBe(403);
        expect(r.corpo).toContain('domain is not verified');
        vi.restoreAllMocks();
    });

    it('su ok non tocca il corpo e restituisce la Response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
        const r = await externalFetch('resend', 'https://api.resend.com/emails');
        expect(r.ok).toBe(true);
        expect(r.res).toBeInstanceOf(Response);
        expect(await r.res!.json()).toEqual({ id: 'x' });
        vi.restoreAllMocks();
    });

    it('su errore di rete NON lancia: ritorna un esito leggibile', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const r = await externalFetch('fcm', 'https://fcm.googleapis.com/x');
        expect(r.ok).toBe(false);
        expect(r.corpo).toContain('ECONNREFUSED');
        vi.restoreAllMocks();
    });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Comando: `npx vitest run __tests__/lib/logging-external.test.ts`
Atteso: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa**

Crea `src/lib/logging/external.ts`:

```ts
import { logEvento } from './logger';

/**
 * Chiamate ai provider esterni (Resend, FCM, web-push, Aruba/SDI).
 *
 * INVARIANTE: su `!res.ok` il CORPO della risposta viene letto e propagato.
 * Loggare uno status senza il corpo È il bug, non la mancanza di un logger:
 * per mesi le email di credenziali non sono mai arrivate perché il provider
 * rispondeva 403 con "the domain is not verified" e il codice registrava solo
 * il numero 403. Stesso vizio, ancora presente, in push/native-push.ts, che
 * legge il corpo FCM e poi lo scarta (`fcm_http_${res.status}`).
 */

const CORPO_MAX = 500;

export interface EsitoEsterno {
    ok: boolean;
    stato: number;
    /** Il corpo dell'errore, sempre presente quando ok === false. */
    corpo: string;
    /** La Response, solo quando ok === true (il corpo NON è stato consumato). */
    res?: Response;
}

export async function externalFetch(
    provider: string,
    url: string,
    init?: RequestInit
): Promise<EsitoEsterno> {
    const t0 = Date.now();
    try {
        const res = await fetch(url, init);
        const ms = Date.now() - t0;

        if (!res.ok) {
            let corpo = '';
            try {
                corpo = (await res.text()).slice(0, CORPO_MAX);
            } catch {
                corpo = '[corpo illeggibile]';
            }
            logEvento('esterno', 'error', { provider, stato: res.status, ms, corpo });
            return { ok: false, stato: res.status, corpo };
        }

        logEvento('esterno', 'info', { provider, stato: res.status, ms });
        return { ok: true, stato: res.status, corpo: '', res };
    } catch (err) {
        const ms = Date.now() - t0;
        const corpo = err instanceof Error ? err.message : String(err);
        logEvento('esterno', 'error', { provider, stato: 0, ms, corpo }, err);
        return { ok: false, stato: 0, corpo };
    }
}
```

- [ ] **Step 4: Ripara `native-push.ts` (butta ancora via il corpo FCM)**

In `src/lib/push/native-push.ts`, sostituisci il blocco che oggi termina con `return { ok: false, error: \`fcm_http_${res.status}\` }` (righe ~125-132):

```ts
    if (res.ok) return { ok: true }
    // Token non registrato → subscription da rimuovere (come 410/404 web).
    if (res.status === 404) return { ok: false, gone: true }
    const errText = await res.text().catch(() => '')
    if (res.status === 400 && /UNREGISTERED|INVALID_ARGUMENT/i.test(errText)) {
      return { ok: false, gone: true }
    }
    // Il corpo dell'errore NON si butta via: `fcm_http_400` non dice nulla,
    // il corpo FCM dice esattamente cosa non va.
    logEvento('push', 'error', {
      provider: 'fcm',
      stato: res.status,
      piattaforma: platform,
      corpo: errText.slice(0, 500),
    })
    return { ok: false, error: `fcm_${res.status}: ${errText.slice(0, 200)}` }
```

E aggiungi in testa al file: `import { logEvento } from '@/lib/logging/logger'`.

- [ ] **Step 5: Aggiungi il battito di successo dell'email**

In `src/lib/email/send.ts` (già riparato dalla PR #23 per il corpo dell'errore, manca il **successo**), aggiungi in testa `import { logEvento } from '@/lib/logging/logger'` e sostituisci il `return { ok: true, error: null }` con:

```ts
    logEvento('email', 'info', { provider: 'resend', stato: res.status, destinatario: hashDestinatario(to) })
    return { ok: true, error: null }
```

dove `hashDestinatario` è `hashCorrelabile` importato da `@/lib/logging/redact` (l'indirizzo non va mai in chiaro).

Sostituisci anche il `console.log` del ramo "provider non configurato" (riga 37), che è di livello **info** e quindi non finirebbe in tabella:

```ts
  if (!apiKey) {
    logEvento('config', 'error', { mancante: 'RESEND_API_KEY', operazione: 'sendEmail' })
    return { ok: false, error: 'provider email non configurato (RESEND_API_KEY assente)' }
  }
```

> Nota: sparisce anche la stampa di `text` in chiaro, che conteneva `Password temporanea: ...` — per mesi le password temporanee dei genitori sono finite nei Runtime Logs.

- [ ] **Step 6: Esegui i test**

Comando: `npx vitest run __tests__/lib/logging-external.test.ts && npx vitest run`
Atteso: tutti verdi.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logging/external.ts src/lib/push/native-push.ts src/lib/email/send.ts __tests__/lib/logging-external.test.ts
git commit -m "feat(logging): externalFetch con corpo d'errore obbligatorio; FCM e email non lo buttano più via"
```

---

## Task 12: Battito cardiaco dei cron

I 5 endpoint sono chiamati da pg_net in fire-and-forget con `EXCEPTION WHEN OTHERS THEN null`. Se il secret è sbagliato o il job non è schedulato, **non arriva niente e quindi non si logga niente**. Si sorveglia l'**assenza**.

**Files:**
- Modify: `src/app/api/push/dispatch/route.ts`
- Modify: `src/app/api/notifiche/promemoria/route.ts`
- Modify: `src/app/api/mensa/allergie-check/route.ts`
- Modify: `src/app/api/pagamenti/solleciti/run/route.ts`
- Modify: `src/app/api/pagamenti/fattura/sync/route.ts`

- [ ] **Step 1: Aggiungi il battito a ciascuno dei 5 endpoint**

In ogni file, aggiungi l'import:

```ts
import { logEvento } from '@/lib/logging/logger'
```

Subito **dopo** il controllo del `CRON_SECRET`, aggiungi il battito d'ingresso; nel ramo di secret errato, il diniego:

```ts
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      logEvento('cron', 'error', { job: 'push-dispatch', esito: 'secret-errato' })
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    logEvento('cron', 'info', { job: 'push-dispatch', esito: 'avviato' })
```

E prima di ogni `return` di successo, il battito di chiusura con i contatori già presenti:

```ts
    logEvento('cron', 'info', { job: 'push-dispatch', esito: 'ok', inviate, notifiche })
    return NextResponse.json({ success: true, data: { inviate, native_inviate, notifiche, subs_rimosse } })
```

Nomi dei job da usare: `push-dispatch`, `notifiche-promemoria`, `mensa-allergie-check`, `pagamenti-solleciti`, `fattura-sync`.

- [ ] **Step 2: Verifica**

Comando: `npx vitest run __tests__/api/cron-secret.test.ts`
Atteso: PASS (i test asseriscono il 401, che non cambia).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/push/dispatch/route.ts src/app/api/notifiche/promemoria/route.ts src/app/api/mensa/allergie-check/route.ts src/app/api/pagamenti/solleciti/run/route.ts src/app/api/pagamenti/fattura/sync/route.ts
git commit -m "feat(logging): battito cardiaco dei 5 cron (si sorveglia l'assenza, non solo l'errore)"
```

Query di sorveglianza (da usare in produzione):

```sql
select contesto->>'job' as job, max(visto_l_ultima) as ultimo
from app_log where evento = 'cron' group by 1 order by 2;
```

Se un job non compare, **non sta girando** — ed è precisamente ciò che oggi non si saprebbe.

---

## Task 13: Logger client e route di ingestion

**Files:**
- Create: `src/lib/logging/client.ts`
- Create: `src/instrumentation-client.ts`
- Create: `src/app/api/logs/route.ts`
- Modify: `__tests__/api/zod-coverage.test.ts`
- Test: `__tests__/api/logs-ingestion.test.ts`

- [ ] **Step 1: Scrivi il logger client**

Crea `src/lib/logging/client.ts`. **Niente `'use client'`** e nessun accesso a `window` a livello di modulo: i moduli client vengono comunque valutati sul server durante il prerender, e un accesso a `window` a module-scope romperebbe `npm run build`.

```ts
/**
 * Logger del browser e della WebView nativa.
 *
 * NON importa nulla di Node. NON logga mai i body: il patch di `fetch` vede anche
 * POST /auth/v1/token, cioè le password dei genitori in chiaro.
 *
 * Il flush usa `navigator.sendBeacon`, che NON passa da `fetch`: così il loop
 * infinito (un log che genera una fetch che genera un log…) è impossibile PER
 * COSTRUZIONE, non per convenzione.
 */

const SINK = '/api/logs';
const CODA_MAX = 20;
const DEDUP_MS = 60_000;

// Header con cui Next marca le proprie chiamate interne: prefetch RSC, Server
// Action, HMR. Senza queste esclusioni i log sarebbero inutilizzabili per rumore.
const HEADER_NEXT = [
    'rsc',
    'next-action',
    'next-router-state-tree',
    'next-router-prefetch',
    'next-router-segment-prefetch',
    'next-hmr-refresh',
];

export interface EventoClient {
    livello: 'warn' | 'error';
    evento: string;
    messaggio: string;
    stack?: string;
    route?: string;
    stato?: number;
    digest?: string;
}

let coda: EventoClient[] = [];
const visti = new Map<string, number>();
let installato = false;
let fetchOriginale: typeof fetch | null = null;

function piattaforma(): 'web' | 'ios' | 'android' {
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua) && /Capacitor/i.test(ua)) return 'ios';
    if (/Android/i.test(ua) && /Capacitor/i.test(ua)) return 'android';
    return 'web';
}

/** Non lancia mai: un bug dell'osservabilità non deve diventare un bug dell'app. */
export function logClient(e: EventoClient): void {
    try {
        const chiave = `${e.evento}|${e.messaggio}`;
        const ora = Date.now();
        const ultimo = visti.get(chiave);
        if (ultimo && ora - ultimo < DEDUP_MS) return; // throttle: 1 log identico/minuto
        visti.set(chiave, ora);

        if (coda.length >= CODA_MAX) coda.shift(); // drop dei più vecchi
        coda.push({ ...e, messaggio: e.messaggio.slice(0, 500), stack: e.stack?.slice(0, 2000) });
        salvaInCoda();
    } catch {
        /* fail-open */
    }
}

/**
 * Coda persistita: `syncEngine` gira OFFLINE, e i suoi errori (Dexie/IndexedDB)
 * non passano né dal patch di fetch né dalle boundary React. Senza persistenza,
 * i bug del percorso offline — che sono proprio quelli che servono — non
 * arriverebbero mai.
 */
function salvaInCoda(): void {
    try {
        localStorage.setItem('kv_log_coda', JSON.stringify(coda.slice(-CODA_MAX)));
    } catch {
        /* quota piena o storage negato: pazienza */
    }
}

function riprendiCoda(): void {
    try {
        const raw = localStorage.getItem('kv_log_coda');
        if (raw) coda = [...(JSON.parse(raw) as EventoClient[]), ...coda].slice(-CODA_MAX);
    } catch {
        /* no-op */
    }
}

export function flush(): void {
    if (!coda.length) return;
    const corpo = JSON.stringify({ eventi: coda, piattaforma: piattaforma() });
    const inviati = [...coda];
    coda = [];
    try {
        const ok =
            typeof navigator !== 'undefined' &&
            typeof navigator.sendBeacon === 'function' &&
            navigator.sendBeacon(SINK, new Blob([corpo], { type: 'application/json' }));
        if (!ok && fetchOriginale) {
            // fallback: si usa il fetch ORIGINALE, mai window.fetch (che è patchato)
            void fetchOriginale(SINK, {
                method: 'POST',
                body: corpo,
                headers: { 'content-type': 'application/json' },
                keepalive: true,
            }).catch(() => { coda = [...inviati, ...coda].slice(-CODA_MAX); salvaInCoda(); });
        }
        localStorage.removeItem('kv_log_coda');
    } catch {
        coda = [...inviati, ...coda].slice(-CODA_MAX);
    }
}

/** Idempotente e SSR-safe. Va chiamata da instrumentation-client.ts. */
export function installaLoggerClient(): void {
    if (installato || typeof window === 'undefined') return;
    installato = true;

    riprendiCoda();

    // Catturato a RUNTIME (non a module-eval): il bridge Capacitor gira a
    // document-start e potrebbe a sua volta aver riassegnato window.fetch.
    const originale = window.fetch.bind(window);
    fetchOriginale = originale;

    window.fetch = async (input, init) => {
        try {
            const req = input instanceof Request ? input : null;
            const url = String(req ? req.url : input);

            let salta = url.startsWith(SINK) || !/^(https?:|\/)/.test(url);
            if (!salta) {
                const h = new Headers(init?.headers ?? req?.headers); // Next passa header come oggetto piano
                salta = HEADER_NEXT.some((k) => h.has(k));
                if (!salta) {
                    try {
                        // `_rsc` può comparire SENZA `=`: includes('_rsc=') lo mancherebbe.
                        salta = new URL(url, location.href).searchParams.has('_rsc');
                    } catch { /* no-op */ }
                }
            }
            if (salta) return originale(input, init);

            const t0 = performance.now();
            try {
                const res = await originale(input, init); // args INTATTI: mai ricostruire la Request
                if (!res.ok) {
                    logClient({
                        livello: 'error', evento: 'fetch',
                        messaggio: `${(init?.method ?? req?.method ?? 'GET').toUpperCase()} ${percorso(url)} → ${res.status}`,
                        route: percorso(url), stato: res.status,
                    });
                }
                return res; // niente .clone(): nessun tee dello stream
            } catch (e) {
                logClient({
                    livello: 'error', evento: 'fetch',
                    messaggio: `rete: ${percorso(url)} — ${String(e)}`.slice(0, 300),
                    route: percorso(url), stato: 0,
                });
                throw e;
            }
        } catch {
            return originale(input, init); // fail-open
        }
    };

    window.addEventListener('error', (e) => {
        logClient({
            livello: 'error', evento: 'js',
            messaggio: e.message || 'errore js',
            stack: e.error instanceof Error ? e.error.stack : undefined,
            route: location.pathname,
        });
        flush();
    });

    // NESSUNA boundary React copre questo caso: è la rete più importante
    // (nel repo ci sono ~249 `.catch(() => {})`).
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        logClient({
            livello: 'error', evento: 'unhandledrejection',
            messaggio: r instanceof Error ? r.message : String(r),
            stack: r instanceof Error ? r.stack : undefined,
            route: location.pathname,
        });
        flush();
    });

    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('online', flush); // il device è tornato in rete: si svuota la coda
}

/** Solo il pathname: la query contiene ?userId=, ?token=… */
function percorso(url: string): string {
    try {
        return new URL(url, location.href).pathname;
    } catch {
        return url.split('?')[0];
    }
}
```

- [ ] **Step 2: Crea `src/instrumentation-client.ts`**

È la convenzione ufficiale di Next: gira **dopo il caricamento del documento e prima dell'hydration**, una volta sola. Un provider React non basterebbe: `useEffect` di un componente padre viene eseguito **dopo** quelli dei figli, quindi si perderebbero proprio le fetch del primo caricamento.

```ts
import { installaLoggerClient, logClient, flush } from '@/lib/logging/client';

installaLoggerClient();

/**
 * Breadcrumb di navigazione: correla l'errore alla rotta di provenienza.
 * Next avvisa se l'inizializzazione supera i 16 ms: qui dentro niente di pesante.
 */
export function onRouterTransitionStart(url: string) {
    void url;
    flush(); // svuota la coda prima di cambiare pagina
}

export { logClient };
```

- [ ] **Step 3: Crea la route di ingestion**

Crea `src/app/api/logs/route.ts`. È un endpoint **ostile per progetto**: deve accettare anche richieste anonime (gli errori sulla pagina di login sono il caso d'uso principale).

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseData } from '@/lib/validation/http'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { appLog } from '@/lib/logging/app-log'
import { getRequestUserId } from '@/lib/auth/require-staff'

/**
 * Ingestion dei log del client (browser + WebView nativa).
 *
 * Anonima per necessità: gli errori sulla pagina di login sono il caso d'uso
 * principale, e lì l'utente non ha ancora un'identità. Difese, in ordine:
 *  1. cap byte del body letto da content-length PRIMA di request.json() —
 *     altrimenti zod validerebbe solo dopo aver già parsato in memoria;
 *  2. rate-limit per ip;
 *  3. zod + cap del batch;
 *  4. troncamento server-side (lo fa anche la RPC).
 */

const BYTE_MAX = 64_000
const BATCH_MAX = 20

const eventoSchema = z.object({
    livello: z.enum(['warn', 'error']),
    evento: z.string().max(40),
    messaggio: z.string().max(1000),
    stack: z.string().max(4000).optional(),
    route: z.string().max(300).optional(),
    stato: z.number().int().optional(),
    digest: z.string().max(120).optional(),
})

const bodySchema = z.object({
    eventi: z.array(eventoSchema).min(1).max(BATCH_MAX),
    piattaforma: z.enum(['web', 'ios', 'android']).default('web'),
})

export async function POST(request: Request) {
    const rl = rateLimit(`logs:${clientIp(request)}`, { limit: 30, windowMs: 60_000 })
    if (!rl.ok) {
        return NextResponse.json(
            { error: 'Troppe richieste' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
        )
    }

    const len = Number(request.headers.get('content-length') ?? 0)
    if (len > BYTE_MAX) {
        return NextResponse.json({ error: 'Payload troppo grande' }, { status: 413 })
    }

    let raw: unknown
    try {
        raw = await request.json()
    } catch {
        return NextResponse.json({ error: 'Body non valido' }, { status: 400 })
    }

    const parsed = parseData(bodySchema, raw)
    if ('response' in parsed) return parsed.response

    const utenteId = getRequestUserId(request) // identità OPZIONALE
    const requestId = request.headers.get('x-request-id') ?? undefined

    for (const e of parsed.data.eventi.slice(0, BATCH_MAX)) {
        await appLog({
            livello: e.livello,
            evento: `client:${e.evento}`,
            sorgente: 'client',
            piattaforma: parsed.data.piattaforma,
            messaggio: e.messaggio,
            stack: e.stack,
            route: e.route,
            statoHttp: e.stato,
            utenteId: utenteId ?? undefined,
            requestId,
            contestoExtra: e.digest ? { digest: e.digest } : {},
        })
    }

    return NextResponse.json({ ok: true, ricevuti: parsed.data.eventi.length })
}
```

- [ ] **Step 4: Aggiungi `'logs'` al lock zod**

In `__tests__/api/zod-coverage.test.ts`, aggiungi `'logs'` in fondo all'array `GRUPPI_COPERTI`:

```ts
    // M6 (agenda condivisa — zod dal giorno 1)
    'agenda',
    // Logging (2026-07-12): la route di ingestion valida con zod dal giorno 1
    'logs',
```

> Va aggiunto **nello stesso commit** che crea la route: il test asserisce `expect(files.length).toBeGreaterThan(0)` e fallirebbe su un gruppo vuoto.

- [ ] **Step 5: Scrivi il test della route**

Crea `__tests__/api/logs-ingestion.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/logs/route';
import { resetRateLimit } from '@/lib/security/rate-limit';

vi.mock('@/lib/logging/app-log', () => ({
    appLog: vi.fn(async () => {}),
    SCHEMA_MANCANTE: new Set<string>(),
    fingerprintDi: () => 'x',
}));

const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/logs', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
    });

describe('POST /api/logs', () => {
    beforeEach(() => resetRateLimit());

    it('accetta un batch valido anche da utente anonimo', async () => {
        const res = await POST(post({ eventi: [{ livello: 'error', evento: 'js', messaggio: 'boom' }] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, ricevuti: 1 });
    });

    it('rifiuta un batch oltre il massimo (zod)', async () => {
        const eventi = Array.from({ length: 21 }, () => ({ livello: 'error', evento: 'js', messaggio: 'x' }));
        const res = await POST(post({ eventi }));
        expect(res.status).toBe(400);
    });

    it('rifiuta un payload troppo grande PRIMA di parsarlo (413)', async () => {
        const res = await POST(post({ eventi: [] }, { 'content-length': '100000' }));
        expect(res.status).toBe(413);
    });

    it('applica il rate-limit', async () => {
        const uno = () => POST(post(
            { eventi: [{ livello: 'error', evento: 'js', messaggio: 'x' }] },
            { 'x-forwarded-for': '1.2.3.4' }
        ));
        for (let i = 0; i < 30; i++) await uno();
        const res = await uno();
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('rifiuta un livello non ammesso', async () => {
        const res = await POST(post({ eventi: [{ livello: 'info', evento: 'js', messaggio: 'x' }] }));
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 6: Esegui i test**

Comando: `npx vitest run __tests__/api/logs-ingestion.test.ts __tests__/api/zod-coverage.test.ts`
Atteso: PASS.

- [ ] **Step 7: Verifica la build**

Comando: `npm run build`
Atteso: build ok (in particolare `src/lib/logging/client.ts` non deve rompere il prerender: nessun accesso a `window` a module-scope).

- [ ] **Step 8: Commit**

```bash
git add src/lib/logging/client.ts src/instrumentation-client.ts src/app/api/logs/route.ts __tests__/api/logs-ingestion.test.ts __tests__/api/zod-coverage.test.ts
git commit -m "feat(logging): logger client (fetch patch, onerror, coda offline) + POST /api/logs"
```

---

## Task 14: Error boundary che loggano da sé

**Il punto controintuitivo e decisivo del piano.** Oggi, *senza* `error.tsx`, gli errori React non catturati passano dalla boundary implicita di Next → `reportError()` → e **`window.onerror` li vede**. Nel momento in cui si aggiunge `error.tsx`, quegli stessi errori diventano "catturati da una boundary esplicita" e in produzione Next esegue solo `console.error`, **senza** `reportError()`.

I due meccanismi **non si sommano: si sottraggono.** Se ci si affidasse a `window.onerror` come rete unica, dopo il deploy si vedrebbero **meno** errori di prima. Il log dentro le boundary è quindi **obbligatorio**.

**Files:**
- Create: `src/app/error.tsx`
- Create: `src/app/global-error.tsx`

- [ ] **Step 1: Crea `src/app/error.tsx`**

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { logClient, flush } from '@/lib/logging/client'

/**
 * OBBLIGATORIO loggare qui: con una boundary ESPLICITA, Next non chiama più
 * reportError() → window.onerror non vede più questi errori.
 *
 * In produzione il messaggio degli errori Server Component è generico per
 * progetto: il valore sta tutto nel `digest`, che incrocia questo log con quello
 * di src/instrumentation.ts (dove c'è lo stack vero).
 */
export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    const inviato = useRef<string | null>(null)

    useEffect(() => {
        const chiave = error.digest ?? `${error.name}:${error.message}`
        if (inviato.current === chiave) return // dedup: StrictMode monta due volte
        inviato.current = chiave
        logClient({
            livello: 'error',
            evento: 'boundary',
            messaggio: error.message || 'errore di rendering',
            stack: error.stack,
            digest: error.digest,
            route: typeof location === 'undefined' ? undefined : location.pathname,
        })
        flush()
    }, [error])

    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
            <h2 className="text-xl font-semibold">Qualcosa è andato storto</h2>
            <p className="text-muted-foreground max-w-md text-sm">
                Si è verificato un errore imprevisto. Puoi riprovare: se il problema persiste,
                segnalalo alla segreteria indicando il codice qui sotto.
            </p>
            {error.digest && (
                <code className="rounded bg-black/5 px-2 py-1 text-xs">{error.digest}</code>
            )}
            <button
                onClick={reset}
                className="rounded-full bg-[var(--kv-primary,#f5a623)] px-6 py-2 font-semibold text-white"
            >
                Riprova
            </button>
        </div>
    )
}
```

- [ ] **Step 2: Crea `src/app/global-error.tsx`**

`global-error` **sostituisce il root layout**: deve dichiarare i propri `<html>`/`<body>` e importare gli stili, altrimenti la pagina d'errore esce nuda. Non può esportare `metadata`.

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { logClient, flush } from '@/lib/logging/client'
import './globals.css'

/**
 * Copre l'unico buco che error.tsx non può coprire: un crash di src/app/layout.tsx
 * (che legge il cookie del contrasto e monta RootProviders).
 * Sostituisce il root layout → deve ridichiarare <html> e <body>.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    const inviato = useRef<string | null>(null)

    useEffect(() => {
        const chiave = error.digest ?? `${error.name}:${error.message}`
        if (inviato.current === chiave) return
        inviato.current = chiave
        logClient({
            livello: 'error',
            evento: 'global-boundary',
            messaggio: error.message || 'errore fatale',
            stack: error.stack,
            digest: error.digest,
        })
        flush()
    }, [error])

    return (
        <html lang="it">
            <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
                <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center' }}>
                    <h2 style={{ fontSize: 20, fontWeight: 600 }}>Kidville non è riuscita a caricarsi</h2>
                    <p style={{ maxWidth: 420, fontSize: 14, opacity: 0.7 }}>
                        Si è verificato un errore imprevisto. Ricarica la pagina: se il problema
                        persiste, segnalalo alla segreteria indicando il codice qui sotto.
                    </p>
                    {error.digest && (
                        <code style={{ background: 'rgba(0,0,0,.06)', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}>
                            {error.digest}
                        </code>
                    )}
                    <button
                        onClick={reset}
                        style={{ background: '#f5a623', color: '#fff', border: 0, borderRadius: 999, padding: '8px 24px', fontWeight: 600, cursor: 'pointer' }}
                    >
                        Ricarica
                    </button>
                </div>
            </body>
        </html>
    )
}
```

- [ ] **Step 3: Verifica la build**

Comando: `npm run build`
Atteso: build ok.

- [ ] **Step 4: Verifica che l'hydration NON si sia rotta (il canarino)**

`error.tsx` **non** introduce un boundary Suspense (l'incidente storico di `loading.tsx` fu causato dal Suspense, che sospende l'albero e blocca gli `useEffect` dei client component data-heavy). Ma la verifica va fatta, non assunta.

Comando: `npx playwright test e2e/teacher-attendance.spec.ts`
Atteso: PASS — l'appello docente carica gli alunni e persiste la presenza al reload.

> Se questo test è rosso, l'hydration si è rotta: **fermarsi**, non proseguire con i lotti.

- [ ] **Step 5: Commit**

```bash
git add src/app/error.tsx src/app/global-error.tsx
git commit -m "feat(logging): error boundary che loggano da sé (senza, window.onerror perderebbe gli errori React)"
```

---

## Task 15: Silenziare il logger negli E2E

**Files:**
- Modify: `playwright.config.ts`

- [ ] **Step 1: Passa la variabile al server**

Gli E2E girano su `next dev`, seriali (`workers: 1`) e sono già instabili sotto carico: 239 route che loggano amplificherebbero il rumore.

```ts
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // Il logger è silenzioso sotto vitest (guardia su process.env.VITEST) ma non
    // sotto Playwright, che avvia un vero server Next: qui si spegne esplicitamente.
    env: { KV_LOG_LEVEL: 'silent' },
  },
```

- [ ] **Step 2: Verifica**

Comando: `npx playwright test e2e/teacher-attendance.spec.ts`
Atteso: PASS, e nessuna riga `KV_` nell'output del server.

- [ ] **Step 3: Commit**

```bash
git add playwright.config.ts
git commit -m "chore(logging): logger silenzioso negli E2E Playwright"
```

---

## Task 16: Gate completo di fine Fase 1

- [ ] **Step 1: ESLint**

Comando: `npx eslint . --max-warnings 0`
Atteso: 0 errori, 0 warning.

- [ ] **Step 2: Typecheck + unit**

Comando: `npm run gate`
Atteso: `tsc --noEmit` pulito e tutti i test vitest verdi.

- [ ] **Step 3: Build**

Comando: `npm run build`
Atteso: build ok.

- [ ] **Step 4: E2E**

Comando: `npm run e2e`
Atteso: tutti verdi (in particolare `teacher-attendance`).

- [ ] **Step 5: Collaudo osservabile in dev**

> ⚠️ `.env.local` punta a **produzione**: non eseguire scritture. Le chiamate qui sotto sono letture o dinieghi.

```bash
npm run dev
# in un altro terminale:
curl -i localhost:3000/api/me -H 'x-user-id: <ID-UTENTE-TEST>'
```

Atteso nell'output del server: una riga `KV_OK rid=… uid=… ruolo=… ms=…`, e l'header `x-request-id` nella risposta.

```bash
curl -i localhost:3000/api/notifiche/promemoria -X POST -H 'x-cron-secret: SBAGLIATO'
```

Atteso: `401` e una riga `KV_ERR evento=cron … esito=secret-errato`.

- [ ] **Step 6: Collaudo della correlazione**

Metti temporaneamente un `throw new Error('kv-test')` in una route qualunque già wrappata, chiamala, e verifica che compaiano **due** righe con lo **stesso `rid`**: una da `withRoute` (`KV_ERR … op=…`) e una da `instrumentation` (`KV_ERR evento=unhandled …`). Poi rimuovi il `throw`.

- [ ] **Step 7: Commit del gate**

```bash
git commit --allow-empty -m "chore(logging): Fase 1 completa — gate verdi"
```

---

# FASE 2 — Rollout di `withRoute` sulle 239 route

Ogni lotto è una modifica **meccanica**: si avvolge ogni export HTTP, si **rimuove** il `console.error` del catch (ora ridondante: il wrapper logga da sé) e si lascia **tutto il resto invariato** — i gate e gli import zod devono restare nel file, altrimenti si rompono il lock `zod-coverage` e `scripts/audit-route-gates.mjs`.

**Trasformazione tipo:**

```ts
// PRIMA
export async function GET(request: NextRequest) {
    try {
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;
        // …
    } catch (err) {
        console.error(`Errore GET /api/admin/parents/[id]:`, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
}

// DOPO
export const GET = withRoute('admin/parents/[id]:GET', async (request: NextRequest) => {
    try {
        const auth = await requireStaff(request);
        if (auth.response) return auth.response;
        // …
    } catch {
        // il wrapper ha già loggato l'eccezione con stack, utente e payload
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
```

Import da aggiungere in ogni file: `import { withRoute } from '@/lib/logging/with-route'`.

## Task 17: Il test-lock incrementale

**Files:**
- Create: `__tests__/architecture/logging-coverage.test.ts`

- [ ] **Step 1: Scrivi il lock (con la lista vuota: passa)**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coverage-lock del logging: ogni route.ts dei gruppi già coperti DEVE avere
 * TUTTI i suoi export HTTP avvolti in withRoute(). La copertura non può regredire.
 *
 * Modellato su __tests__/api/zod-coverage.test.ts. Differenza importante: NON si
 * verifica l'IMPORT di withRoute (si aggirerebbe importandolo senza usarlo), ma
 * che non sopravviva nessun `export async function GET` non avvolto.
 *
 * Lista incrementale: ogni lotto aggiunge i propri prefissi.
 */
const GRUPPI_COPERTI: string[] = [
    // (i lotti li aggiungono qui, uno alla volta)
];

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const NUDO = new RegExp(`export\\s+(?:async\\s+)?function\\s+(?:${METODI})\\b`, 'g');
const AVVOLTO = new RegExp(`export\\s+const\\s+(?:${METODI})\\s*=\\s*withRoute\\(`, 'g');

function routeFilesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...routeFilesUnder(full));
        else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
}

describe('logging coverage lock', () => {
    it.each(GRUPPI_COPERTI.length ? GRUPPI_COPERTI : [null])(
        'gruppo %s: ogni export HTTP è avvolto in withRoute',
        (gruppo) => {
            if (gruppo === null) return; // lista ancora vuota
            const files = routeFilesUnder(path.join(API_ROOT, gruppo));
            expect(files.length, `nessuna route trovata sotto ${gruppo}`).toBeGreaterThan(0);

            const scoperte: string[] = [];
            for (const f of files) {
                const src = fs.readFileSync(f, 'utf8');
                const nudi = src.match(NUDO) ?? [];
                const avvolti = src.match(AVVOLTO) ?? [];
                if (nudi.length > 0 || avvolti.length === 0) {
                    scoperte.push(path.relative(API_ROOT, f));
                }
            }
            expect(scoperte, `route con export non avvolti in ${gruppo}`).toEqual([]);
        }
    );
});
```

- [ ] **Step 2: Verifica che passi (lista vuota)**

Comando: `npx vitest run __tests__/architecture/logging-coverage.test.ts`
Atteso: PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/architecture/logging-coverage.test.ts
git commit -m "test(logging): lock incrementale della copertura withRoute"
```

---

## Task 18 — Lotto 0: Collaudo (`me`, `educator-sections`, `debug`, `debug-supabase`, `public`)

~6 route, sole letture, zero PII. Serve a validare il **formato** e la correlazione prima di toccare qualcosa che conta.

- [ ] **Step 1: Applica la trasformazione tipo** a tutte le `route.ts` sotto `src/app/api/{me,educator-sections,debug,debug-supabase,public}/`.

- [ ] **Step 2: Aggiungi i prefissi al lock**

In `__tests__/architecture/logging-coverage.test.ts`:

```ts
const GRUPPI_COPERTI: string[] = [
    // Lotto 0 — collaudo
    'me', 'educator-sections', 'debug', 'debug-supabase', 'public',
];
```

- [ ] **Step 3: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: tutto verde.

- [ ] **Step 4: Collaudo osservabile**

`npm run dev`, poi `curl -i localhost:3000/api/me -H 'x-user-id: <ID-TEST>'`.
Atteso: riga `KV_OK` con `rid`, `uid`, `ruolo`, `ms`, e header `x-request-id` nella risposta.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/me src/app/api/educator-sections src/app/api/debug src/app/api/debug-supabase src/app/api/public __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 0 (collaudo)"
```

---

## Task 19 — Lotto 1: Docente base (`attendance`, `notes`, `tasks`, `avvisi`, `agenda`, `grades`)

~17 route, già coperte da test, nessun multipart.

- [ ] **Step 1:** applica la trasformazione tipo a tutte le `route.ts` di quei gruppi (esclusi per ora `tasks/upload` e `avvisi/upload`, che vanno nel lotto multipart).
- [ ] **Step 2:** aggiungi `'attendance', 'notes', 'tasks', 'avvisi', 'agenda', 'grades'` a `GRUPPI_COPERTI`.
- [ ] **Step 3:** `npx vitest run __tests__/api` → tutti verdi (in particolare `tasks.test.ts`, `p0-gates.test.ts`).
- [ ] **Step 4:** `npx eslint . --max-warnings 0 && npm run gate` → verde.
- [ ] **Step 5:** commit `feat(logging): withRoute — lotto 1 (docente base)`.

---

## Task 20 — Lotto 2: `parent/**` (~24 route)

**È il vero collaudo della redazione**: qui vivono allergie, certificati medici, giustifiche.

- [ ] **Step 1:** applica la trasformazione tipo (escluso `parent/medical-certificates` POST, che è multipart).
- [ ] **Step 2:** aggiungi `'parent'` a `GRUPPI_COPERTI`.
- [ ] **Step 3:** **verifica anti-PII sul campo.** Avvia `npm run dev`, provoca un 400 su una route parent con un body che contiene testo libero, e ispeziona la riga `KV_ERR`: il campo `payload` deve mostrare `[redatto:str/N]`, **mai** il testo. Se compare anche un solo valore in chiaro, **fermarsi** e correggere `redact.ts`.
- [ ] **Step 4:** `npx eslint . --max-warnings 0 && npm run gate` → verde.
- [ ] **Step 5:** commit `feat(logging): withRoute — lotto 2 (parent, collaudo redazione)`.

---

## Task 21 — Lotto 3: `primaria/**` (25 route)

Giudizi, scrutinio, audit (`logScrittura`) e **FEA**: qui il wrapper non deve alterare l'ordine delle scritture né la firma elettronica.

- [ ] **Step 1: Applica la trasformazione tipo** (vedi il blocco "Trasformazione tipo" in testa alla Fase 2) a tutte le `route.ts` sotto `src/app/api/primaria/`, **escluse** `primaria/allegati` e `primaria/fascicolo` (multipart → lotto 7).

- [ ] **Step 2: Aggiungi `'primaria'` a `GRUPPI_COPERTI`** in `__tests__/architecture/logging-coverage.test.ts`.

- [ ] **Step 3: Verifica che audit e FEA non siano regrediti**

Comando: `npx vitest run __tests__/api __tests__/lib/fea-audit.test.ts __tests__/lib/fea-signature-log.test.ts`
Atteso: tutti verdi. In particolare, l'ordine delle scritture su `audit_scritture_docente` non deve cambiare: il wrapper avvolge l'handler, non ne riordina il corpo.

- [ ] **Step 4: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/primaria __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 3 (primaria)"
```

---

## Task 22 — Lotto 4: testo libero e media (27 route)

`chat` (7), `diary` (5), `locker` (5), `mensa` (6), `gallery` (2), `notifiche` (2). `chat.contenuto` è testo libero puro: la redazione deve azzerarlo.

- [ ] **Step 1: Applica la trasformazione tipo** a tutte le `route.ts` di quei gruppi, **escluse** `chat/upload` e `gallery/upload` (multipart → lotto 7).

- [ ] **Step 2: Aggiungi `'chat', 'diary', 'locker', 'mensa', 'gallery', 'notifiche'` a `GRUPPI_COPERTI`.**

- [ ] **Step 3: Verifica anti-PII sul testo libero**

Avvia `npm run dev`, provoca un 400 su `/api/chat/messages` con un body che contiene un `contenuto` riconoscibile, e ispeziona la riga `KV_ERR`: il campo `payload` deve mostrare `[redatto:str/N]`, **mai** il testo del messaggio.

- [ ] **Step 4: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat src/app/api/diary src/app/api/locker src/app/api/mensa src/app/api/gallery src/app/api/notifiche __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 4 (testo libero e media)"
```

---

## Task 23 — Lotto 5: `pagamenti` (23 route)

Soldi, PDF e stream. Il rischio specifico di questo lotto è **rompere le Response Blob**: il wrapper non clona mai la risposta, ma va verificato sul campo.

- [ ] **Step 1: Applica la trasformazione tipo** a tutte le `route.ts` sotto `src/app/api/pagamenti/`.

- [ ] **Step 2: Aggiungi `'pagamenti'` a `GRUPPI_COPERTI`.**

- [ ] **Step 3: Verifica che gli stream non si siano rotti**

Avvia `npm run dev` e scarica una ricevuta PDF e una fattura: il file deve arrivare integro e apribile.
Atteso: il PDF si apre; nei log compare una riga `KV_OK`, e **nessun** log contiene il contenuto binario.

- [ ] **Step 4: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/pagamenti __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 5 (pagamenti)"
```

---

## Task 24 — Lotto 6a: `admin` letture e report (~30 route)

- [ ] **Step 1: Applica la trasformazione tipo** alle `route.ts` di sola lettura sotto `src/app/api/admin/`: `audit`, `settings`, `schools`, `search`, `staff` (GET), `merch` (GET), `students` (GET), `parents` (GET), `form-models` (GET), `sections`.

- [ ] **Step 2: NON toccare ancora `GRUPPI_COPERTI`** — `'admin'` copre l'intero sottoalbero e va aggiunto solo alla fine del lotto 6c.

- [ ] **Step 3: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin
git commit -m "feat(logging): withRoute — lotto 6a (admin, letture)"
```

---

## Task 25 — Lotto 6b: `admin` scritture (~40 route)

Qui vivono 3 delle 73 scritture fire-and-forget (`admin/iscrizioni/route.ts:246,291,357`). Dopo questo lotto i loro errori diventano visibili — non grazie al wrapper, ma grazie al fetch strumentato del Task 6: PostgREST risponde con un 4xx che ora viene sempre loggato, anche se il codice applicativo lo ignora.

- [ ] **Step 1: Applica la trasformazione tipo** alle `route.ts` di scrittura sotto `src/app/api/admin/`: `iscrizioni`, `students` (POST/PATCH/DELETE), `parents` (POST/PATCH/DELETE), `merch` (scritture), `primaria`, `competenze`, `staff` (scritture), `form-models` (scritture), `settings` (PATCH).

- [ ] **Step 2: Verifica che le scritture silenziose ora si vedano**

Avvia `npm run dev` e provoca un insert destinato a fallire (es. una iscrizione con un `scuola_id` inesistente → violazione di vincolo).
Atteso: una riga `KV_ERR evento=db … stato=4xx corpo="…"` **con il messaggio PostgREST**, anche se la route non segnala nulla all'utente.

- [ ] **Step 3: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin
git commit -m "feat(logging): withRoute — lotto 6b (admin, scritture)"
```

---

## Task 26 — Lotto 6c: `admin` irreversibili (~26 route)

`gdpr/erase`, `regenerate-credentials`, `protocolli/**`, `sidi/**` (escluso `sidi/import`, multipart), `seed-full`, `wipe`, `import` (escluso l'upload), `apply-enrollment-migration`.

- [ ] **Step 1: Applica la trasformazione tipo** a queste `route.ts`.

- [ ] **Step 2: Aggiungi `'admin'` a `GRUPPI_COPERTI`** — ora il lock verifica l'intero sottoalbero `admin/**` (96 route).

- [ ] **Step 3: Verifica che il lock passi davvero**

Comando: `npx vitest run __tests__/architecture/logging-coverage.test.ts`
Atteso: PASS. Se fallisce, elenca le route ancora scoperte: vanno avvolte prima di proseguire.

- [ ] **Step 4: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 6c (admin, irreversibili) — admin/** completo"
```

---

## Task 27 — Lotto 7: multipart (12 route)

`admin/sidi/import`, `avvisi/upload`, `chat/upload`, `forms/upload`, `gallery/upload`, `iscrizione/upload`, `parent/medical-certificates` (POST), `primaria/allegati`, `primaria/fascicolo`, `public/forms/[token]/upload`, `tasks/upload`, `teacher/modulistica`.

È l'unica famiglia in cui il wrapper **cambia comportamento**: non legge il body, quindi il payload di queste route non finisce mai nei log. È voluto — clonare un multipart significherebbe duplicare in RAM uno ZIP SIDI o una foto da 20 MB.

- [ ] **Step 1: Applica la trasformazione tipo** alle 12 route.

- [ ] **Step 2: Verifica un upload reale**

Avvia `npm run dev` e carica una foto in `gallery/upload`.
Atteso: il file arriva e viene salvato; nei log compare una riga `KV_OK`; **nessun log contiene il contenuto del file** (verifica con `grep` sull'output del server: la dimensione delle righe deve restare nell'ordine delle centinaia di byte).

- [ ] **Step 3: Aggiungi `'teacher'`, `'forms'`, `'iscrizione'` a `GRUPPI_COPERTI`** (gli altri gruppi sono già coperti dai lotti precedenti).

- [ ] **Step 4: Gate**

Comando: `npx eslint . --max-warnings 0 && npm run gate`
Atteso: verde.

- [ ] **Step 5: Commit**

```bash
git add src/app/api __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 7 (multipart, il body non si tocca)"
```

---

## Task 28 — Lotto 8: cron, push, auth (~14 route)

Ultimi, e per una ragione precisa: qui un errore è **silente** — nessun utente si lamenta se un cron non parte. E il gate non è `requireStaff` ma `x-cron-secret`, quindi il wrapper non deve presupporre l'esistenza di un utente (e infatti non lo fa: `contesto().userId` resta `undefined` e il logger omette il campo).

- [ ] **Step 1: Applica la trasformazione tipo** a: i 5 cron (che hanno già il battito del Task 12), `push/subscribe`, `push/vapid-public-key`, `fea`, `panic-alert`, `register`, `auth/**`.

- [ ] **Step 2: Aggiungi `'push', 'fea', 'panic-alert', 'register', 'auth'` a `GRUPPI_COPERTI`.**

- [ ] **Step 3: Verifica i cron**

Comando: `npx vitest run __tests__/api/cron-secret.test.ts`
Atteso: PASS (i test asseriscono il 401 su secret errato, che non cambia).

Poi, in dev: `curl -i localhost:3000/api/push/dispatch -X POST -H 'x-cron-secret: SBAGLIATO'`
Atteso: 401 + riga `KV_ERR evento=cron job=push-dispatch esito=secret-errato`.

- [ ] **Step 4: Gate completo (fine della Fase 2)**

```bash
npx eslint . --max-warnings 0
npm run gate
npm run build
npm run e2e
```
Atteso: tutti verdi. Il lock `logging-coverage` copre ora tutte le 239 route.

- [ ] **Step 5: Commit**

```bash
git add src/app/api __tests__/architecture/logging-coverage.test.ts
git commit -m "feat(logging): withRoute — lotto 8 (cron, push, auth) — copertura completa delle 239 route"
```

---

# FASE 3 — Igiene, PRD, rilascio

## Task 29: `no-console` con bulk suppressions

I 430 `console.*` legacy non si toccano a mano: si azzerano con le soppressioni native di ESLint 9.39. **Non** si usa il livello `warn`: la CI gira `eslint . --max-warnings 0`, quindi un warning è già un fallimento.

- [ ] **Step 1: Aggiungi la regola in `eslint.config.mjs`**

```js
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**", "out/**", "build/**", "next-env.d.ts",
    "ios/**", "android/**",
    "e2e/primaria-360/**",
  ]),
  // Il logging passa da src/lib/logging: console.* diretto è un bypass
  // dell'osservabilità (niente redazione, niente contesto, niente persistenza).
  { files: ["src/**/*.{ts,tsx}"], rules: { "no-console": "error" } },
  { files: ["src/lib/logging/**", "src/instrumentation.ts", "src/middleware.ts"], rules: { "no-console": "off" } },
  { files: ["scripts/**", "e2e/**", "*.config.{js,mjs,ts}"], rules: { "no-console": "off" } },
]);
```

- [ ] **Step 2: Genera la baseline delle soppressioni**

Comando: `npx eslint src --suppress-rule no-console`
Effetto: crea `eslint-suppressions.json` con i ~430 casi legacy. La CI torna verde senza aver toccato un solo file.

- [ ] **Step 3: Verifica**

Comando: `npx eslint . --max-warnings 0`
Atteso: 0 errori.

> Da qui in poi ogni lotto che rimuove `console.*` deve rigenerare il file con `npx eslint . --prune-suppressions` e committarlo: se restano soppressioni inutilizzate, ESLint esce con codice non-zero.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs eslint-suppressions.json
git commit -m "chore(logging): no-console attivo su src/ con baseline di soppressioni legacy"
```

---

## Task 30: Collaudo del fallimento silenzioso (il test che giustifica tutto il lavoro)

Riproduce in laboratorio l'incidente delle credenziali. **Se questo non è verde, il design ha fallito nell'unico compito per cui è nato.**

- [ ] **Step 1: Provider configurato ma dominio non verificato**

In un `.env.local` **di staging** (mai contro produzione), imposta `RESEND_API_KEY` valida e `OTP_FROM_EMAIL` su un dominio non verificato. Invoca la route che invia le credenziali.

Atteso nei log:
```
KV_ERR evento=esterno provider=resend stato=403 corpo="... domain is not verified ..."
```
e la funzione deve restituire un esito che il chiamante **non può ignorare** (`{ ok: false, error: '…' }`).

- [ ] **Step 2: Provider non configurato**

Rimuovi `RESEND_API_KEY`. Atteso: `KV_ERR evento=config mancante=RESEND_API_KEY` — **non** un `console.log` rassicurante di livello info.

- [ ] **Step 3: Nessuna password nei log**

Comando: `npm run dev 2>&1 | grep -i "password\|Password temporanea"`
Atteso: **zero risultati**.

- [ ] **Step 4: FCM con token fasullo**

Invoca `push/dispatch` con una subscription fasulla. Atteso: riga di errore **col corpo FCM**, non `fcm_http_400`.

- [ ] **Step 5: Cron non schedulato**

```sql
select contesto->>'job' as job, max(visto_l_ultima) from app_log where evento = 'cron' group by 1;
```
Atteso: i 5 job compaiono. Se uno manca, non sta girando.

- [ ] **Step 6: Volume**

```sql
select livello, evento, count(*), sum(occorrenze) from app_log group by 1,2 order by 3 desc limit 20;
select pg_size_pretty(pg_total_relation_size('app_log'));
```
Se in cima c'è rumore ricorrente (es. i `warn` di `auth`), declassalo a `info` **prima** del rilascio.

---

## Task 31: PRD e rilascio

**AGENTS.md, punto 2:** un intervento non è completo se il PRD non è allineato.

- [ ] **Step 1: Aggiorna `PRD REGISTRO ELETTRONICO.md`**

Aggiungi una voce di changelog datata (2026-07-12) che descriva: il sistema di logging strutturato, la tabella `app_log` con retention 30 giorni, la redazione a lista bianca dei dati personali, e il fatto che i log di produzione **non contengono dati identificativi** (solo uuid e hash correlabili). **Nessun nome, nessuna email, nessun dato reale del DB di produzione nel PRD** — il repo è pubblico.

- [ ] **Step 2: Gate finale completo**

```bash
npx eslint . --max-warnings 0
npx vitest run
npm run build
npm run e2e
```
Tutti verdi.

- [ ] **Step 3: Push e PR**

```bash
git push -u origin feat/logging-strutturato
gh pr create --title "feat(logging): logging strutturato pervasivo" --body "..."
```

- [ ] **Step 4: Merge e deploy**

⚠️ Il merge in `main` va lanciato **dall'utente** (autorizzazione esplicita).

- [ ] **Step 5: Verifica in produzione**

Dopo il deploy, con MCP Vercel: `get_runtime_logs` con `query: "KV_OK"` → devono comparire le righe di sintesi. Poi `query: "KV_ERR"` → devono essere poche e comprensibili.
Con MCP Supabase: `select livello, evento, count(*) from app_log group by 1,2;`

- [ ] **Step 6: Pulizia dei branch (AGENTS.md, punto 3)**

Dopo il deploy riuscito, elimina il branch locale e remoto: `main` deve restare l'unico.

---

## Note di rischio (da tenere sott'occhio durante l'esecuzione)

| Rischio | Sintomo | Cosa fare |
|---|---|---|
| `src/instrumentation.ts` messo nella radice | nessun errore, nessun warning, **semplicemente non logga** | verificare con il collaudo del Task 16, Step 6 (devono comparire DUE righe con lo stesso `rid`) |
| Il middleware importa (anche transitivamente) `context.ts` | `npm run build` fallisce su `node:async_hooks` nel bundle Edge | rimuovere l'import: il middleware passa solo l'header |
| Il logger scrive sul DB durante i test | test lenti, o scritture contro **produzione** (`.env.local` punta a prod) | la guardia `process.env.VITEST` deve essere letta **al caricamento del modulo** |
| `parseBody` chiamato due volte sulla stessa richiesta | `Body is unusable` | non è una regressione del piano: il wrapper **non legge** il body |
| Volume di `app_log` esplosivo | tabella che cresce di migliaia di righe/ora | il dedup per fingerprint e il rate-limit su `/api/logs` sono le difese; il collaudo H le verifica |
