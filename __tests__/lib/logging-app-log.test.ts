import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    appLog as appLogSilenzioso,
    appLogBatch as appLogBatchSilenzioso,
} from '@/lib/logging/app-log';

/**
 * Il SINK: la riga che finisce in `app_log`.
 *
 * COME SI TESTA, e perché è più complicato del solito. `app-log.ts` è SILENZIOSO sotto vitest
 * (la guardia è valutata al caricamento del modulo), e deve esserlo: `.env.local` punta al DB di
 * PRODUZIONE, e una suite che scrive righe di log in produzione è un incidente. Ma un sink che
 * nei test non scrive mai è anche un sink che nei test non si può verificare — e "la riga
 * persistita è l'unica cosa che leggeremo in SQL".
 *
 * Perciò `carica()`: `vi.resetModules()` + `VITEST=''` → il modulo si ricarica con la guardia
 * SPENTA, ma con `createLogClient` mockato. Si vede la riga vera, senza toccare nessun database.
 *
 * `spegniLaGuardia` è quindi anche il test più importante che c'è in questo file (in fondo):
 * verifica che l'import NORMALE — quello che fanno gli altri 1.400 test — non tocchi il DB.
 */

const rpc = vi.fn();
const createLogClient = vi.fn(async () => ({ rpc }));

vi.mock('@/lib/supabase/server-client', () => ({
    createLogClient: () => createLogClient(),
}));

type Modulo = typeof import('@/lib/logging/app-log') & typeof import('@/lib/logging/context')
    & typeof import('@/lib/logging/logger');

/**
 * Ricarica il sink con la guardia SILENZIOSO spenta. Il contesto e il logger vanno presi dallo
 * STESSO grafo appena ricaricato: dopo un `resetModules` un `conContesto` importato staticamente
 * scriverebbe su un'altra istanza di AsyncLocalStorage, e il sink non vedrebbe nulla.
 */
async function carica(): Promise<Modulo> {
    vi.resetModules();
    const vecchio = process.env.VITEST;
    process.env.VITEST = '';
    try {
        const sink = await import('@/lib/logging/app-log');
        const ctx = await import('@/lib/logging/context');
        const log = await import('@/lib/logging/logger');
        return { ...sink, ...ctx, ...log };
    } finally {
        process.env.VITEST = vecchio;
    }
}

/** Le righe spedite alla RPC dalla chiamata `n`. `appLog` ne manda una; `appLogBatch`, tutte. */
function righeSpedite(n = 0): Record<string, unknown>[] {
    const [nome, args] = rpc.mock.calls[n] as [string, { righe: Record<string, unknown>[] }];
    expect(nome).toBe('app_log_registra');
    return args.righe;
}

/** La riga che il sink ha spedito alla RPC (la prima, o quella della chiamata `n`). */
function rigaSpedita(n = 0): Record<string, unknown> {
    const righe = righeSpedite(n);
    // `appLog` è `appLogBatch` di UNA riga: se questa lunghezza cambiasse, il conteggio delle
    // chiamate RPC di mezzo file starebbe misurando un'altra cosa.
    expect(righe).toHaveLength(1);
    return righe[0];
}

function erroreConStack(messaggio: string, stack: string): { message: string; stack: string } {
    return { message: messaggio, stack };
}

const STACK = 'Error: boom\n    at uno (/src/a.ts:1:1)\n    at due (/src/b.ts:2:2)';

let spiaLog: ReturnType<typeof vi.spyOn>;
let spiaErr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 1, error: null });
    createLogClient.mockClear();
    // Con la guardia spenta il logger scrive DAVVERO su console: si intercetta (serve anche
    // ad asserire che il fallimento della scrittura resti visibile).
    spiaLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    spiaErr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    spiaLog.mockRestore();
    spiaErr.mockRestore();
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. LA RIGA PERSISTITA — l'unica cosa che leggeremo in SQL.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('la riga persistita', () => {
    it('porta i campi della RigaLog e quelli di CORRELAZIONE presi dal contesto', async () => {
        const m = await carica();
        await m.conContesto({ requestId: 'rid-1', path: '/api/admin/parents/x' }, async () => {
            m.impostaUtente({
                userId: '11111111-2222-3333-4444-555555555555',
                ruolo: 'admin',
                scuolaId: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529',
            });
            await m.appLog({
                livello: 'error',
                evento: 'route',
                messaggio: 'colonna non trovata',
                stack: STACK,
                codice: '42703',
                statoHttp: 500,
            });
        });

        const r = rigaSpedita();
        expect(r.livello).toBe('error');
        expect(r.evento).toBe('route');
        expect(r.messaggio).toBe('colonna non trovata');
        expect(r.codice).toBe('42703');
        expect(r.stato_http).toBe(500);
        expect(r.sorgente).toBe('server');
        expect(r.stack).toBe(STACK);
        // Dal contesto — il logger NON li passa, e non deve poterli falsificare.
        expect(r.request_id).toBe('rid-1');
        expect(r.utente_id).toBe('11111111-2222-3333-4444-555555555555');
        expect(r.utente_ruolo).toBe('admin');
        expect(r.scuola_id).toBe('d53b0fbc-a9eb-4073-b302-73d1d5abd529');
        expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(r.contesto).toEqual({});
    });

    it('la ROUTE è il pattern, non il path grezzo (in questo repo il path è una credenziale)', async () => {
        const m = await carica();
        await m.conContesto(
            { requestId: 'r', path: '/m/8f14e45f-ea3f-4f1a-9c2b-1d2e3f4a5b6c?email=mario@x.it' },
            () => m.appLog({ livello: 'warn', evento: 'route', messaggio: 'x' }),
        );
        const r = rigaSpedita();
        expect(r.route).toBe('/m/[id]');
        expect(String(r.route)).not.toContain('mario@x.it');
    });

    it('fuori da una richiesta (cron, boot) i campi di correlazione sono assenti, non inventati', async () => {
        const m = await carica();
        await m.appLog({ livello: 'error', evento: 'cron', messaggio: 'solleciti falliti' });
        const r = rigaSpedita();
        expect(r.route).toBeUndefined();
        expect(r.utente_id).toBeUndefined();
        expect(r.request_id).toBeUndefined();
        expect(r.evento).toBe('cron');
    });

    it('un utente_id che NON è un uuid non arriva in colonna: 22P02 spegnerebbe il logging per sempre', async () => {
        // 22P02 (invalid input syntax for uuid) NON è un codice di schema mancante: il breaker
        // non si aprirebbe, e OGNI riga fallirebbe in silenzio fino al prossimo deploy.
        const m = await carica();
        await m.conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            m.impostaUtente({ userId: 'non-un-uuid', scuolaId: 'nemmeno-questo' });
            await m.appLog({ livello: 'error', evento: 'route', messaggio: 'x' });
        });
        const r = rigaSpedita();
        expect(r.utente_id).toBeUndefined();
        expect(r.scuola_id).toBeUndefined();
    });

    it('scarta i valori fuori contratto invece di spedirli al DB', async () => {
        const m = await carica();
        await m.appLog({
            livello: 'error',
            evento: 'client',
            messaggio: 'x',
            statoHttp: 3.14 as number,
            piattaforma: 'symbian' as 'web',
        });
        const r = rigaSpedita();
        expect(r.stato_http).toBeUndefined();
        expect(r.piattaforma).toBeUndefined();
    });

    it('una riga del CLIENT porta sorgente e piattaforma', async () => {
        const m = await carica();
        await m.appLog({
            livello: 'error', evento: 'client', messaggio: 'x',
            sorgente: 'client', piattaforma: 'ios',
        });
        const r = rigaSpedita();
        expect(r.sorgente).toBe('client');
        expect(r.piattaforma).toBe('ios');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. LA CATENA VERA: logEvento/logErrore → appLog → RPC.
 *    Non si mocka `appLog`: si guarda cosa arriva DAVVERO alla RPC. È l'unica
 *    verifica che valga qualcosa — la riga in tabella è ciò che leggeremo in SQL.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('la catena logger → sink (cosa ci finisce DAVVERO)', () => {
    it('logErrore: il nome della route arriva in contesto.operazione, non redatto', async () => {
        const m = await carica();
        await m.conContesto({ requestId: 'r', path: '/api/admin/x' }, async () => {
            m.logErrore({ operazione: 'admin/parents:GET', stato: 500 }, new Error('boom'));
            await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        });
        const r = rigaSpedita();
        expect(r.livello).toBe('error');
        expect(r.messaggio).toBe('boom');
        const c = r.contesto as Record<string, unknown>;
        expect(c.operazione).toBe('admin/parents:GET');
    });

    it('logEvento: `redact()` è a LISTA BIANCA — le chiavi note sopravvivono, le altre no', async () => {
        const m = await carica();
        m.logEvento('email', 'warn', {
            // In lista bianca (IN_CHIARO): escono leggibili anche in tabella.
            operazione: 'invio-credenziali',
            provider: 'resend',
            esito: 'fallito',
            stato: 403,
            // FUORI dalla lista bianca: in tabella diventano illeggibili. Non è un bug del
            // sink, è il contratto di `redact` — ma chi chiama deve saperlo, perché il campo
            // che gli serve lo troverebbe solo su Vercel (un giorno di ritenzione).
            motivo: 'dominio non verificato',
            // In DA_HASHARE: senza LOG_HASH_SALT diventa `[redatto]` (fail-closed).
            nome: 'Mario',
            // Numeri e booleani passano sempre.
            tentativi: 3,
        });
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

        const campi = (rigaSpedita().contesto as Record<string, Record<string, unknown>>).campi;
        expect(campi.operazione).toBe('invio-credenziali');
        expect(campi.provider).toBe('resend');
        expect(campi.esito).toBe('fallito');
        expect(campi.stato).toBe(403);
        expect(campi.tentativi).toBe(3);
        // Le due che NON sopravvivono. Questo test esiste per fissarlo per iscritto.
        expect(campi.motivo).toBe('[redatto:str/22]');
        expect(campi.motivo).not.toContain('dominio');
        expect(campi.nome).toBe('[redatto]');
        expect(campi.nome).not.toBe('Mario');
    });

    it('lo `stato` numerico finisce in COLONNA (interrogabile), non solo dentro il jsonb', async () => {
        const m = await carica();
        m.logEvento('route', 'error', { operazione: 'x', stato: 500, ms: 12 });
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        expect(rigaSpedita().stato_http).toBe(500);
    });

    it('un evento NON persistibile (info, non critico) non tocca il DB', async () => {
        const m = await carica();
        m.logEvento('route', 'info', { operazione: 'x', stato: 404 });
        m.logOk({ ms: 3, rt: 'x' });
        await new Promise((r) => setTimeout(r, 5));
        expect(rpc).not.toHaveBeenCalled();
    });

    it('il payload del contesto arriva in tabella GIÀ redatto, senza una seconda passata', async () => {
        const m = await carica();
        await m.conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            m.impostaPayload('body', { tipo: 'nota', descrizione: 'ha avuto una crisi' });
            m.logErrore({ operazione: 'x' }, new Error('boom'));
            await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        });
        const payload = (rigaSpedita().contesto as { payload: { body: Record<string, unknown> } }).payload;
        expect(payload.body.tipo).toBe('nota');
        // Il dato sensibile è redatto UNA volta sola: il marcatore `str/18` sopravvive intatto
        // (una seconda passata di `redact` lo riscriverebbe come `[redatto:str/19]`).
        expect(payload.body.descrizione).toBe('[redatto:str/18]');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. DEDUPLICA — righe identiche si SOMMANO, non si moltiplicano.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('deduplica per impronta', () => {
    it('due errori IDENTICI producono la stessa impronta → una riga sola, occorrenze = 2', async () => {
        // Il DB non lo si può eseguire qui: si simula la semantica esatta della RPC
        // (`ON CONFLICT (fingerprint, giorno) DO UPDATE SET occorrenze = occorrenze + n`),
        // che è il contratto che la migrazione deve rispettare.
        const tabella = new Map<string, { occorrenze: number; messaggio: string }>();
        const giorno = new Date().toISOString().slice(0, 10);
        rpc.mockImplementation(async (_nome: string, args: { righe: Record<string, unknown>[] }) => {
            for (const r of args.righe) {
                const chiave = `${String(r.fingerprint)}|${giorno}`;
                const esistente = tabella.get(chiave);
                if (esistente) esistente.occorrenze += 1;
                else tabella.set(chiave, { occorrenze: 1, messaggio: String(r.messaggio) });
            }
            return { data: 1, error: null };
        });

        const m = await carica();
        const riga = {
            livello: 'error' as const, evento: 'db', messaggio: 'connessione persa',
            stack: STACK, codice: '08006',
        };
        await m.conContesto({ requestId: 'r1', path: '/api/x' }, () => m.appLog({ ...riga }));
        await m.conContesto({ requestId: 'r2', path: '/api/x' }, () => m.appLog({ ...riga }));

        expect(rpc).toHaveBeenCalledTimes(2);
        expect(tabella.size).toBe(1); // UNA riga
        expect([...tabella.values()][0].occorrenze).toBe(2); // con occorrenze = 2
        // Il `request_id` della riga è quello della PRIMA occorrenza: è un campione, non
        // l'insieme. È il prezzo della deduplica, ed è scritto nella migrazione.
    });

    it('la tempesta del client (mille errori identici) resta UNA riga', async () => {
        const impronte = new Set<string>();
        rpc.mockImplementation(async (_n: string, args: { righe: Record<string, unknown>[] }) => {
            for (const r of args.righe) impronte.add(String(r.fingerprint));
            return { data: 1, error: null };
        });
        const m = await carica();
        for (let i = 0; i < 1000; i++) {
            await m.appLog({
                livello: 'error', evento: 'client', messaggio: 'Failed to fetch',
                stack: STACK, sorgente: 'client', piattaforma: 'ios',
            });
        }
        expect(rpc).toHaveBeenCalledTimes(1000);
        expect(impronte.size).toBe(1);
    });

    it('due ROUTE diverse con lo stesso messaggio NON collassano (la colonna route mentirebbe)', async () => {
        const m = await carica();
        const riga = { livello: 'error' as const, evento: 'route', messaggio: 'Errore interno' };
        await m.conContesto({ requestId: 'r', path: '/api/alunni' }, () => m.appLog({ ...riga }));
        await m.conContesto({ requestId: 'r', path: '/api/pagamenti' }, () => m.appLog({ ...riga }));
        expect(rigaSpedita(0).fingerprint).not.toBe(rigaSpedita(1).fingerprint);
    });

    it('due UTENTI diversi non collassano (altrimenti l\'indice per utente sarebbe inservibile)', async () => {
        const m = await carica();
        const riga = { livello: 'error' as const, evento: 'route', messaggio: 'Errore interno' };
        const uno = '11111111-1111-1111-1111-111111111111';
        const due = '22222222-2222-2222-2222-222222222222';
        await m.conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            m.impostaUtente({ userId: uno });
            await m.appLog({ ...riga });
        });
        await m.conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            m.impostaUtente({ userId: due });
            await m.appLog({ ...riga });
        });
        expect(rigaSpedita(0).fingerprint).not.toBe(rigaSpedita(1).fingerprint);
    });

    it('lo stesso errore da PUNTI diversi del codice non collassa (i frame entrano nell\'impronta)', async () => {
        const m = await carica();
        const riga = { livello: 'error' as const, evento: 'db', messaggio: 'boom' };
        await m.appLog({ ...riga, stack: 'Error: boom\n    at uno (/src/a.ts:1:1)' });
        await m.appLog({ ...riga, stack: 'Error: boom\n    at due (/src/z.ts:9:9)' });
        expect(rigaSpedita(0).fingerprint).not.toBe(rigaSpedita(1).fingerprint);
    });

    it('un `request_id` diverso NON cambia l\'impronta (o la deduplica non dedupplicherebbe nulla)', async () => {
        const m = await carica();
        const riga = { livello: 'error' as const, evento: 'db', messaggio: 'boom', stack: STACK };
        await m.conContesto({ requestId: 'aaa', path: '/api/x' }, () => m.appLog({ ...riga }));
        await m.conContesto({ requestId: 'bbb', path: '/api/x' }, () => m.appLog({ ...riga }));
        expect(rigaSpedita(0).fingerprint).toBe(rigaSpedita(1).fingerprint);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. CIRCUIT BREAKER — si apre SOLO sullo schema mancante.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('circuit breaker', () => {
    async function dueScritture(errore: unknown): Promise<number> {
        const m = await carica();
        // Il contatore va azzerato QUI, non nel `beforeEach`: un `it` che interroga due
        // guasti diversi (503 e statement timeout) chiama questa funzione due volte, e
        // `rpc.mock.calls` è cumulativo — il secondo confronto leggerebbe le chiamate del
        // primo e conterebbe 4 dove il breaker ne ha fatte 2.
        rpc.mockReset();
        rpc.mockResolvedValue({ data: 1, error: null });
        rpc.mockResolvedValueOnce({ data: null, error: errore });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'due' });
        return rpc.mock.calls.length;
    }

    it('SI APRE su 42P01 (la tabella non esiste: il DB E2E della CI non è mai migrato)', async () => {
        expect(await dueScritture({ code: '42P01', message: 'relation "app_log" does not exist' })).toBe(1);
    });

    it('SI APRE su PGRST202 — la RPC non è nella schema cache: il codice VERO del DB E2E', async () => {
        // Non era nel piano. Qui si chiama una FUNZIONE: quando manca, PostgREST risponde 404
        // PGRST202, non PGRST205 (tabella) né 42P01 (che arriva solo se la funzione c'è).
        expect(await dueScritture({
            code: 'PGRST202',
            message: 'Could not find the function public.app_log_registra(righe) in the schema cache',
        })).toBe(1);
    });

    it.each(['42703', 'PGRST200', 'PGRST204', 'PGRST205'])('SI APRE su %s', async (code) => {
        expect(await dueScritture({ code, message: 'qualcosa' })).toBe(1);
    });

    it('SI APRE sul ripiego TESTUALE (PostgREST non popola sempre `code`)', async () => {
        expect(await dueScritture({
            code: '',
            message: 'Could not find the table \'public.app_log\' in the schema cache',
        })).toBe(1);
    });

    it('NON si apre su un TIMEOUT DI RETE (un blip non deve spegnere i log fino al deploy)', async () => {
        expect(await dueScritture({ message: 'TypeError: fetch failed' })).toBe(2);
    });

    it('NON si apre su un 503 (DB in affanno) né su uno statement timeout', async () => {
        expect(await dueScritture({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(2);
        expect(await dueScritture({ message: 'Service Unavailable' })).toBe(2);
    });

    it('NON si apre su un errore di PERMESSI (42501): è una configurazione da correggere, non uno schema assente', async () => {
        expect(await dueScritture({ code: '42501', message: 'permission denied for table app_log' })).toBe(2);
    });

    it('NON si apre quando la chiamata LANCIA (rete giù): l\'eccezione non è uno schema mancante', async () => {
        const m = await carica();
        rpc.mockRejectedValueOnce(new TypeError('fetch failed'));
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'due' });
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('aperto, non costruisce nemmeno il client (è il ramo che gira migliaia di volte in CI)', async () => {
        const m = await carica();
        rpc.mockResolvedValueOnce({ data: null, error: { code: '42P01', message: 'x' } });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        createLogClient.mockClear();
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'due' });
        expect(createLogClient).not.toHaveBeenCalled();
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. NIENTE RICORSIONE, E IL FALLIMENTO RESTA VISIBILE.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('ricorsione', () => {
    it('una scrittura fallita non ne scatena un\'altra: appLog gira UNA volta sola', async () => {
        // Senza le difese, l'errore della RPC verrebbe loggato → `persisti` → `appLog` →
        // un'altra RPC → un altro errore → … fino all'esaurimento della memoria.
        const m = await carica();
        rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(createLogClient).toHaveBeenCalledTimes(1);
    });

    it('...ma il fallimento ESCE su console: è l\'unico canale da cui ce ne accorgeremmo', async () => {
        const m = await carica();
        rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });

        const righe = spiaErr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(righe).toContain('KV_ERR');
        expect(righe).toContain('app_log_registra');
        expect(righe).toContain('esito=fallito');
    });

    it('anche l\'apertura del breaker si annuncia (una riga sola, poi il silenzio)', async () => {
        const m = await carica();
        rpc.mockResolvedValue({ data: null, error: { code: '42P01', message: 'does not exist' } });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'due' });

        const righe = spiaErr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(righe).toContain('esito=schema-assente');
        expect(righe.match(/schema-assente/g)).toHaveLength(1);
    });

    it('la catena async resta marcata: un log emesso DENTRO il sink non arriva in tabella', async () => {
        const m = await carica();
        // La RPC, mentre gira, prova a loggare: è la simulazione del gestore d'errore che
        // rilogga. `inLogger()` è true → `persisti` scarta → nessuna seconda RPC.
        rpc.mockImplementationOnce(async () => {
            m.logEvento('db', 'error', { operazione: 'annidato' }, new Error('errore dentro il logger'));
            return { data: 1, error: null };
        });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'uno' });
        expect(rpc).toHaveBeenCalledTimes(1);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. NON LANCIA MAI, NON BLOCCA MAI.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('fail-open', () => {
    it('un contesto CICLICO non lancia e non fa perdere la riga', async () => {
        const m = await carica();
        const ciclo: Record<string, unknown> = { tipo: 'nota' };
        ciclo.se_stesso = ciclo;
        await expect(m.appLog({
            livello: 'error', evento: 'db', messaggio: 'x', contestoExtra: { campi: ciclo },
        })).resolves.toBeUndefined();
        const c = rigaSpedita().contesto as { campi: Record<string, unknown> };
        expect(c.campi.tipo).toBe('nota');
        expect(c.campi.se_stesso).toBe('[ciclo]');
    });

    it('un getter ostile costa QUEL campo, non la riga', async () => {
        const m = await carica();
        const extra: Record<string, unknown> = { operazione: 'x' };
        Object.defineProperty(extra, 'boom', {
            enumerable: true,
            get() { throw new Error('getter ostile'); },
        });
        await m.appLog({ livello: 'error', evento: 'db', messaggio: 'x', contestoExtra: extra });
        const c = rigaSpedita().contesto as Record<string, unknown>;
        expect(c.operazione).toBe('x');
        // `serializza` non propaga il throw del getter: la riga arriva comunque.
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('un contesto ENORME viene ridotto campo per campo, non buttato via', async () => {
        const m = await carica();
        await m.appLog({
            livello: 'error', evento: 'db', messaggio: 'x',
            contestoExtra: { operazione: 'importa', gigante: 'x'.repeat(20_000) },
        });
        const c = rigaSpedita().contesto as Record<string, unknown>;
        expect(c.operazione).toBe('importa'); // il campo utile sopravvive
        expect(c.gigante).toBe('[troppo-grande]'); // quello impazzito no
    });

    it('un `createLogClient` che esplode non fa fallire la richiesta dell\'utente', async () => {
        const m = await carica();
        createLogClient.mockRejectedValueOnce(new Error('SUPABASE_SERVICE_ROLE_KEY mancante'));
        await expect(m.appLog({ livello: 'error', evento: 'db', messaggio: 'x' }))
            .resolves.toBeUndefined();
        expect(spiaErr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('esito=eccezione');
    });

    it('una RigaLog che arriva da JS non tipizzato non rompe niente', async () => {
        const m = await carica();
        await expect(m.appLog({} as never)).resolves.toBeUndefined();
        await expect(m.appLog(null as never)).resolves.toBeUndefined();
    });

    it('`after()` LANCIA fuori da un contesto di richiesta: la riga si scrive lo stesso', async () => {
        // Verificato: «`after` was called outside a request scope». Qui — nei test, nei cron
        // fuori route, negli script — non c'è nessuna lambda che possa congelarsi, quindi il
        // throw si ignora e la scrittura procede.
        const m = await carica();
        await expect(m.appLog({ livello: 'error', evento: 'cron', messaggio: 'x' }))
            .resolves.toBeUndefined();
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('un errore Postgres con dati personali nel testo arriva in tabella MASCHERATO', async () => {
        const m = await carica();
        m.logErrore({ operazione: 'x' }, erroreConStack(
            'duplicate key value violates unique constraint\nDETAIL: Key (email)=(mario.rossi@example.com) already exists.',
            'Error: duplicate\n    at x (/a.ts:1:1)',
        ));
        await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
        const r = rigaSpedita();
        expect(String(r.messaggio)).not.toContain('mario.rossi@example.com');
        expect(String(r.messaggio)).toContain('Key (email)=(…)');
        expect(JSON.stringify(r)).not.toContain('mario.rossi');
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. IL BATCH — un round-trip, non venti.
 *
 * `/api/logs` ingerisce fino a 20 eventi per richiesta, ed è una route ANONIMA: con un
 * `await appLog(...)` dentro il ciclo erano 20 chiamate RPC SEQUENZIALI al DB per una sola
 * POST che chiunque può fare 30 volte al minuto. La RPC accetta un array da sempre.
 *
 * Il batch non è un percorso di scrittura NUOVO: `appLog` È `appLogBatch` di una riga sola.
 * Perciò qui si verifica soprattutto che il batch non abbia perso per strada nessuna delle
 * proprietà che rendono `appLog` sicura — breaker, anti-ricorsione, fail-open, silenzio.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('appLogBatch — venti righe, UNA chiamata', () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => ({
        livello: 'error' as const,
        evento: 'client:js',
        messaggio: `errore ${i}`,
        sorgente: 'client' as const,
    }));

    it('spedisce l\'intero array in un solo round-trip, in ordine', async () => {
        const m = await carica();
        await m.appLogBatch(batch(20));

        // Sul codice difettoso (un `await appLog` per evento) questa riga diceva 20.
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(createLogClient).toHaveBeenCalledTimes(1);

        const righe = righeSpedite();
        expect(righe).toHaveLength(20);
        expect(righe.map((r) => r.messaggio)).toEqual(batch(20).map((r) => r.messaggio));
        expect(righe.every((r) => r.sorgente === 'client')).toBe(true);
    });

    it('ogni riga del batch prende i campi di CORRELAZIONE dal contesto, una per una', async () => {
        const m = await carica();
        const uid = '11111111-2222-3333-4444-555555555555';
        await m.conContesto({ requestId: 'rid-9', path: '/api/logs' }, async () => {
            m.impostaUtente({ userId: uid, ruolo: 'genitore' });
            await m.appLogBatch([
                { livello: 'error', evento: 'client:js', messaggio: 'uno' },
                { livello: 'warn', evento: 'client:fetch', messaggio: 'due' },
            ]);
        });

        const righe = righeSpedite();
        expect(righe).toHaveLength(2);
        expect(righe.every((r) => r.request_id === 'rid-9')).toBe(true);
        expect(righe.every((r) => r.utente_id === uid)).toBe(true);
        expect(righe.every((r) => r.utente_ruolo === 'genitore')).toBe(true);
        // Due guasti diversi restano due righe: l'impronta si calcola PER RIGA, non per batch.
        expect(righe[0].fingerprint).not.toBe(righe[1].fingerprint);
    });

    it('un batch VUOTO non spende un round-trip', async () => {
        const m = await carica();
        await m.appLogBatch([]);
        expect(rpc).not.toHaveBeenCalled();
        expect(createLogClient).not.toHaveBeenCalled();
    });

    it('il BREAKER vale anche per il batch (il DB E2E non ha la RPC)', async () => {
        const m = await carica();
        rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'schema cache' } });
        await m.appLogBatch(batch(3));
        await m.appLogBatch(batch(3));
        expect(rpc).toHaveBeenCalledTimes(1); // la seconda non parte nemmeno
    });

    it('una riga ILLEGGIBILE costa sé stessa, non le altre diciannove', async () => {
        // Su una route di ingestione le righe accanto sono log VERI di guasti VERI, e nessuno
        // le rispedirà: `sendBeacon` non riporta l'esito e il client ha già svuotato la coda.
        const m = await carica();
        await m.appLogBatch([
            { livello: 'error', evento: 'client:js', messaggio: 'buona' },
            null as never,
            { livello: 'warn', evento: 'client:fetch', messaggio: 'anche questa' },
        ]);

        const righe = righeSpedite();
        expect(righe).toHaveLength(2);
        expect(righe.map((r) => r.messaggio)).toEqual(['buona', 'anche questa']);
        // E la riga persa NON è persa in silenzio: esce su console (mai in tabella — sarebbe
        // il primo giro di una ricorsione).
        expect(spiaErr.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('riga-illeggibile');
    });

    it('non lancia mai, nemmeno se il chiamante non è tipizzato', async () => {
        const m = await carica();
        await expect(m.appLogBatch(null as never)).resolves.toBeUndefined();
        await expect(m.appLogBatch('boh' as never)).resolves.toBeUndefined();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('la catena resta marcata: un log emesso DENTRO il batch non torna in tabella', async () => {
        const m = await carica();
        rpc.mockImplementationOnce(async () => {
            m.logEvento('db', 'error', { operazione: 'annidato' }, new Error('dentro il logger'));
            return { data: 1, error: null };
        });
        await m.appLogBatch(batch(5));
        expect(rpc).toHaveBeenCalledTimes(1);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8. LA GUARDIA. Il test più importante del file: `.env.local` punta a PRODUZIONE.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('silenzioso nei test', () => {
    it('l\'import NORMALE (quello degli altri 1.400 test) non tocca il DB', async () => {
        // `appLogSilenzioso` è importato staticamente, cioè con VITEST attivo: la guardia è
        // stata valutata al caricamento e vale `true`. Nessuna chiamata deve partire.
        await appLogSilenzioso({ livello: 'error', evento: 'db', messaggio: 'NON deve arrivare in prod' });
        // Stessa guardia sul batch: è la porta che `/api/logs` apre a chiunque, e nei test
        // viene invocata come una route qualunque.
        await appLogBatchSilenzioso([{ livello: 'error', evento: 'db', messaggio: 'nemmeno questa' }]);
        expect(rpc).not.toHaveBeenCalled();
        expect(createLogClient).not.toHaveBeenCalled();
    });
});
