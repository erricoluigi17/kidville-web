import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import {
    formattaRiga, logOk, logErrore, logEvento, vaPersistito, EVENTI_PERSISTITI,
    type Valore,
} from '@/lib/logging/logger';

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

    it('una CHIAVE forgiata non può fabbricare una seconda riga di log col marker', () => {
        // Le chiavi non vengono quotate: un `\n` nella chiave spezzerebbe la riga, e la
        // seconda metà arriverebbe a Vercel col suo bravo marker — non un log invisibile,
        // un log che MENTE.
        const riga = formattaRiga('KV_EVT', {
            provider: 'resend',
            ['x\nKV_OK rid=vittima ms']: 1,
        } as Record<string, Valore>);
        expect(riga).not.toContain('\n');
        expect(riga).not.toContain('KV_OK');
        expect(riga).not.toContain('vittima');
        expect(riga).toContain('provider=resend'); // i campi sani restano
        expect(riga).toContain('scartate=1'); // e il log dice ciò che ha buttato
    });

    it('scarta anche le chiavi con spazi, `=` o virgolette (sfaserebbero le coppie)', () => {
        expect(formattaRiga('KV_OK', { 'a=b': 1 } as Record<string, Valore>)).toBe('KV_OK scartate=1');
        expect(formattaRiga('KV_OK', { 'a b': 1 } as Record<string, Valore>)).toBe('KV_OK scartate=1');
        expect(formattaRiga('KV_OK', { 'a"b': 1 } as Record<string, Valore>)).toBe('KV_OK scartate=1');
    });

    it('un getter che lancia costa QUEL campo, non l\'intera riga (Object.entries li invoca)', () => {
        const campi: Record<string, Valore> = { provider: 'resend', esito: 'inviata' };
        Object.defineProperty(campi, 'boom', {
            enumerable: true,
            get() { throw new Error('getter ostile'); },
        });
        const riga = formattaRiga('KV_EVT', campi);
        expect(riga).toContain('provider=resend');
        expect(riga).toContain('esito=inviata');
        expect(riga).toContain('boom=[campo-illeggibile]');
    });

    it('i valori stringa passano da sanificaMessaggio: un\'email non esce in chiaro da NESSUN campo', () => {
        const riga = formattaRiga('KV_EVT', { destinatario: 'mario.rossi@example.com', esito: 'ok' });
        expect(riga).not.toContain('mario.rossi');
        expect(riga).not.toContain('example.com');
        expect(riga).toContain('destinatario=[email]');
        expect(riga).toContain('esito=ok'); // i metadati restano perfettamente leggibili
    });

    it('tiene 0 e false (sono informazione, non vuoto)', () => {
        expect(formattaRiga('KV_OK', { n: 0, ok: false })).toBe('KV_OK n=0 ok=false');
    });

    it('una riga di log resta UNA riga: gli a capo sono escapati, non emessi', () => {
        const riga = formattaRiga('KV_ERR', { msg: 'prima\nseconda' });
        expect(riga).not.toContain('\n');
        expect(riga).toBe('KV_ERR msg="prima\\nseconda"');
    });

    it('la riga non supera il limite oltre il quale Vercel tronca', () => {
        const riga = formattaRiga('KV_ERR', { msg: 'x'.repeat(10_000), coda: 'y'.repeat(10_000) });
        expect(riga.length).toBeLessThanOrEqual(3_500);
        expect(riga.startsWith('KV_ERR ')).toBe(true);
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

    it('include `config`: una variabile critica assente in prod deve sopravvivere alla retention di Vercel', () => {
        expect(EVENTI_PERSISTITI.has('config')).toBe(true);
    });

    it('warn ed error si persistono sempre; un info solo se è un evento in allowlist', () => {
        expect(vaPersistito('error', 'route')).toBe(true);
        expect(vaPersistito('warn', 'db')).toBe(true);
        expect(vaPersistito('info', 'route')).toBe(false);
        expect(vaPersistito('info', 'db')).toBe(false);
        expect(vaPersistito('info', 'email')).toBe(true);
        expect(vaPersistito('info', 'cron')).toBe(true);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Logger RUMOROSO.
 *
 * `SILENZIOSO` è valutata al caricamento del modulo, quindi l'unico modo di
 * osservare ciò che il logger scriverebbe DAVVERO in produzione è ricaricare il
 * modulo con `VITEST` non definita. `app-log` è mockato: senza il mock, quando il
 * Task 8 sostituirà il no-op con la scrittura reale su Supabase, questi test
 * scriverebbero sul DB di PRODUZIONE (`.env.local` punta lì).
 * ──────────────────────────────────────────────────────────────────────────── */

type Riga = Record<string, unknown>;

async function caricaRumoroso() {
    const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    // Logger e contesto DALLO STESSO registry ricaricato: importare `context` da
    // quello statico darebbe un'altra istanza di AsyncLocalStorage, e il logger non
    // vedrebbe il contesto aperto dal test.
    const logger = await import('@/lib/logging/logger');
    const context = await import('@/lib/logging/context');
    return { ...logger, ...context, appLog };
}

/** Tutto ciò che è finito su console, Error compresi (stack, `cause`, proprietà extra). */
function scritto(...spie: ReturnType<typeof vi.spyOn>[]): string {
    return spie
        .flatMap((s) => s.mock.calls.flat())
        .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 })))
        .join('\n');
}

describe('logger — emissione reale (guardia SILENZIOSO disattivata)', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Spiato PRIMA delle chiamate: creare lo spy dentro l'assert darebbe un test vacuo,
        // incapace di fallire.
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('KV_OK porta i campi del contesto della richiesta', async () => {
        const { logOk: ok, conContesto, impostaUtente } = await caricaRumoroso();
        await conContesto({ requestId: 'r1', path: '/api/x' }, async () => {
            impostaUtente({ userId: 'u1', ruolo: 'educator', scuolaId: 's1' });
            ok({ ms: 42, n: 3 });
        });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toBe('KV_OK rid=r1 uid=u1 ruolo=educator sede=s1 ms=42 n=3');
        expect(err).not.toHaveBeenCalled();
    });

    it('KV_ERR emette DUE cose: la riga logfmt e un Error nativo (stack + raggruppamento Vercel)', async () => {
        const { logErrore: le } = await caricaRumoroso();
        const boom = new TypeError('qualcosa è esploso');
        le({ operazione: 'crea-alunno', ms: 7, stato: 500 }, boom);

        expect(err).toHaveBeenCalledTimes(2);
        const riga = err.mock.calls[0][0] as string;
        expect(riga.startsWith('KV_ERR ')).toBe(true);
        // `rt=`, non `op=`: il nome della rotta ha UNA sola chiave su tutti i marker, perché
        // su Vercel la ricerca è full-text (in tabella, invece, resta `operazione`).
        expect(riga).toContain('rt=crea-alunno');
        expect(riga).not.toContain('op=');
        expect(riga).toContain('ms=7');
        expect(riga).toContain('msg="qualcosa è esploso"');
        // Lo stack NON sta sulla riga: mangerebbe il budget dei 3.500 caratteri.
        expect(riga).not.toContain('at ');
        // Lo status HTTP nemmeno: Vercel lo conosce già come metadato di piattaforma.
        expect(riga).not.toContain('stato=');

        const nativo = err.mock.calls[1][0];
        expect(nativo).toBeInstanceOf(Error);
        // Vercel (`get_runtime_errors`) raggruppa per NOME dell'errore: va conservato.
        expect((nativo as Error).name).toBe('TypeError');
        expect((nativo as Error).stack).toContain('at ');
    });

    it('un Error nativo NON viene mai passato a JSON.stringify (darebbe `{}`)', async () => {
        const { logErrore: le } = await caricaRumoroso();
        le({ operazione: 'x' }, new Error('messaggio visibile'));
        expect(scritto(err)).toContain('messaggio visibile');
        expect(scritto(err)).not.toContain('{}');
    });

    it('logEvento: info → console.log/KV_EVT, warn → console.error/KV_WARN, error → console.error/KV_ERR', async () => {
        const { logEvento: ev } = await caricaRumoroso();

        ev('email', 'info', { provider: 'resend', stato: 'inviata' });
        expect(log.mock.calls[0][0]).toBe('KV_EVT evt=email provider=resend stato=inviata');
        expect(err).not.toHaveBeenCalled();

        ev('push', 'warn', { provider: 'fcm', esito: 'token-scaduto' });
        expect(err.mock.calls[0][0]).toBe('KV_WARN evt=push provider=fcm esito=token-scaduto');

        ev('cron', 'error', { azione: 'solleciti' }, new Error('timeout'));
        expect(err.mock.calls[1][0]).toContain('KV_ERR evt=cron azione=solleciti');
        expect(err.mock.calls[1][0]).toContain('msg=timeout');
        // Con un err presente, e livello `error`, esce anche l'Error nativo.
        expect(err.mock.calls[2][0]).toBeInstanceOf(Error);
        // `console.warn` non viene MAI usato: su Vercel, nelle funzioni non-streaming, non
        // produce il livello `warning` ma `error`, e inquinerebbe il filtro degli errori.
        expect(warn).not.toHaveBeenCalled();
    });

    it('l\'Error nativo esce SOLO per livello error: un info/warn non deve inquinare il flusso errori', async () => {
        const { logEvento: ev } = await caricaRumoroso();

        ev('push', 'info', { provider: 'fcm' }, new Error('token rifiutato'));
        expect(log).toHaveBeenCalledTimes(1);
        expect(err).not.toHaveBeenCalled(); // niente Error nativo: `get_runtime_errors` non lo vedrà

        ev('push', 'warn', { provider: 'fcm' }, new Error('token rifiutato'));
        expect(err).toHaveBeenCalledTimes(1); // solo la riga KV_WARN
        expect(err.mock.calls[0][0]).toContain('KV_WARN');
        expect((err.mock.calls as unknown[][]).some((c) => c[0] instanceof Error)).toBe(false);
    });

    it('il contesto vince anche in logOk (un chiamante JS non può falsificare il rid)', async () => {
        const { logOk: ok, conContesto } = await caricaRumoroso();
        await conContesto({ requestId: 'vero', path: '/api/x' }, async () => {
            (ok as (c: Record<string, unknown>) => void)({ ms: 1, rid: 'FALSO' });
        });
        expect(log.mock.calls[0][0]).toContain('rid=vero');
        expect(log.mock.calls[0][0]).not.toContain('FALSO');
    });

    it('persiste solo ciò che va persistito, e mai in modo rientrante', async () => {
        const { logEvento: ev, logOk: ok, appLog } = await caricaRumoroso();

        ok({ ms: 1 });
        ev('route', 'info', { n: 1 });
        ev('db', 'info', { n: 1 });
        expect(appLog).not.toHaveBeenCalled();

        ev('email', 'info', { provider: 'resend' });
        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0]).toMatchObject({ livello: 'info', evento: 'email' });

        ev('db', 'warn', { esito: 'lento' });
        expect(appLog).toHaveBeenCalledTimes(2);
        expect(appLog.mock.calls[1][0]).toMatchObject({ livello: 'warn', evento: 'db' });
    });

    it('lo status HTTP va in COLONNA (statoHttp), non solo dentro il JSONB dei campi', async () => {
        const { logEvento: ev, appLog } = await caricaRumoroso();

        // La riga di esito di `withRoute` per un 5xx: senza questo, `stato_http` sarebbe NULL
        // e i 5xx non si potrebbero filtrare in SQL — si dovrebbe scavare nel JSONB.
        ev('route', 'error', { operazione: 'admin/students:POST', stato: 500, ms: 3 });
        expect(appLog.mock.calls[0][0]).toMatchObject({
            livello: 'error',
            evento: 'route',
            // `messaggio` è il nome della rotta, NON la stringa "500": è la colonna che si
            // legge per prima, e "cinquecento" non dice niente su 239 route.
            messaggio: 'admin/students:POST',
            statoHttp: 500,
        });

        // …ma solo se è un NUMERO: negli eventi di dominio `stato` vale anche 'inviata'.
        ev('email', 'info', { provider: 'resend', stato: 'inviata' });
        expect(appLog.mock.calls[1][0].statoHttp).toBeUndefined();
        expect(appLog.mock.calls[1][0].messaggio).toBe('inviata');
    });

    it('logErrore alza la marca "errore già loggato" (è lui ad avere lo stack vero)', async () => {
        const { logErrore: le, conContesto, erroreGiaLoggato } = await caricaRumoroso();

        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            expect(erroreGiaLoggato()).toBe(false);
            le({ operazione: 'x:POST' }, new Error('boom'));
            // La legge `withRoute`: senza, un `catch { logErrore(err); return 500 }` produrrebbe
            // DUE righe per lo stesso guasto, e la seconda senza stack.
            expect(erroreGiaLoggato()).toBe(true);
        });

        // Fuori da una richiesta è un no-op silenzioso: non c'è dove tenerla che non sia
        // condiviso con le altre richieste in volo.
        expect(() => le({ operazione: 'cron' }, new Error('boom'))).not.toThrow();
        expect(erroreGiaLoggato()).toBe(false);
    });

    it('i campi del chiamante finiscono REDATTI nella riga persistita (difesa in profondità)', async () => {
        const { logEvento: ev, appLog } = await caricaRumoroso();
        ev('email', 'info', { provider: 'resend', destinatario: 'testo-libero-che-non-deve-passare' });
        const riga = appLog.mock.calls[0][0] as { contestoExtra?: { campi?: Record<string, unknown> } };
        expect(riga.contestoExtra?.campi?.provider).toBe('resend');
        expect(String(riga.contestoExtra?.campi?.destinatario)).toContain('[redatto');
    });

    it('il payload del contesto NON viene ri-redatto (la seconda passata cancellerebbe i marcatori)', async () => {
        const { logErrore: le, conContesto, impostaPayload } = await caricaRumoroso();
        await conContesto({ requestId: 'r', path: '/api/x' }, async () => {
            impostaPayload('body', { note: 'x'.repeat(40) });
            le({ operazione: 'x' }, new Error('boom'));
        });
        const riga = err.mock.calls[0][0] as string;
        // `impostaPayload` ha già redatto: `[redatto:str/40]`. Una seconda passata di `redact`
        // redigerebbe QUELLO, e la lunghezza diventerebbe 16 — quella del marcatore stesso.
        expect(riga).toContain('str/40');
        expect(riga).not.toContain('str/16');
    });

    it('il contesto è autorevole: un campo del chiamante non può falsificare il requestId', async () => {
        const { logEvento: ev, conContesto } = await caricaRumoroso();
        await conContesto({ requestId: 'vero', path: '/api/x' }, async () => {
            ev('email', 'info', { rid: 'falso', provider: 'resend' } as Record<string, Valore>);
        });
        expect(log.mock.calls[0][0]).toContain('rid=vero');
        expect(log.mock.calls[0][0]).not.toContain('falso');
    });
});

describe('logger — nessun dato personale può uscire (il senso del modulo)', () => {
    let log: ReturnType<typeof vi.spyOn>;
    let err: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
        err = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('un errore Postgres con dentro un\'email, avvolto in una causa, con un payload di testo libero', async () => {
        const { logErrore: le, conContesto, impostaPayload, appLog } = await caricaRumoroso();

        // L'errore che Postgres produce DAVVERO su violazione di vincolo unico.
        const pg = Object.assign(
            new Error(
                'duplicate key value violates unique constraint "parents_email_key" ' +
                'DETAIL: Key (email)=(mario.rossi@example.com) already exists.',
            ),
            {
                code: '23505',
                details: 'Key (email)=(mario.rossi@example.com) already exists.',
                hint: 'Controlla mario.rossi@example.com',
            },
        );
        pg.name = 'PostgrestError';
        const avvolto = new Error('salvataggio genitore fallito', { cause: pg });

        await conContesto({ requestId: 'r9', path: '/api/anagrafiche/parents' }, async () => {
            impostaPayload('body', {
                email: 'mario.rossi@example.com',
                nome: 'Mario',
                note: 'il bambino ha avuto una crisi durante la merenda',
                codice_fiscale: 'RSSMRA85T10A562S',
            });
            le({ operazione: 'crea-genitore', stato: 500 }, avvolto);
        });

        const uscita = scritto(log, err) + '\n' + JSON.stringify(appLog.mock.calls);

        // Nulla di personale, da nessuna parte: né console (riga + Error nativo + causa) né tabella.
        expect(uscita).not.toContain('mario.rossi@example.com');
        expect(uscita).not.toContain('mario.rossi');
        expect(uscita).not.toContain('example.com');
        expect(uscita).not.toContain('RSSMRA85T10A562S');
        expect(uscita).not.toContain('il bambino ha avuto una crisi');
        expect(uscita).not.toContain('crisi');
        expect(uscita).not.toContain('merenda');

        // …e resta comunque DIAGNOSTICO: si sa quale vincolo è saltato, e su quale colonna.
        const riga = err.mock.calls[0][0] as string;
        expect(riga).toContain('KV_ERR');
        expect(riga).toContain('rid=r9');
        expect(riga).toContain('code=23505');
        expect(riga).toContain('parents_email_key');
        expect(riga).toContain('Key (email)=(…)');
        // `details` sta sulla CAUSA (errore Supabase avvolto): deve arrivare sulla riga lo stesso.
        expect(riga).toContain('det=');
        // La CAUSA (l'errore vero) sopravvive sulla riga: è il messaggio, non lo stack.
        expect(riga).toContain('causa=');
        expect(riga).toContain('duplicate key value');
        // E il payload dice COSA si stava tentando, senza dire su chi.
        expect(riga).toContain('payload=');
        expect(riga).toContain('[redatto');
    });

    it('l\'Error nativo emesso è SANIFICATO (message, stack e causa): è la seconda via d\'uscita', async () => {
        const { logErrore: le } = await caricaRumoroso();
        const pg = new Error('DETAIL: Key (email)=(anna.verdi@example.com) already exists.');
        le({ operazione: 'x' }, new Error('insert fallito', { cause: pg }));

        const nativo = err.mock.calls[1][0] as Error;
        expect(nativo).toBeInstanceOf(Error);
        expect(inspect(nativo, { depth: 8 })).not.toContain('anna.verdi@example.com');
        // La causa c'è ancora — sanificata, non censurata.
        const causa = (nativo as { cause?: unknown }).cause as Error;
        expect(causa).toBeInstanceOf(Error);
        expect(causa.message).toContain('Key (email)=(…)');
    });
});

describe('logger — fail-open: nulla di ciò che sta qui dentro può rompere una route', () => {
    beforeEach(() => {
        vi.stubEnv('VITEST', '');
        vi.stubEnv('KV_LOG_LEVEL', '');
    });
    afterEach(() => {
        vi.doUnmock('@/lib/logging/app-log');
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('se console stessa lancia, il logger non propaga', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('console rotta'); });
        vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('console rotta'); });
        const { logOk: ok, logErrore: le, logEvento: ev } = await caricaRumoroso();
        expect(() => ok({ ms: 1 })).not.toThrow();
        expect(() => le({ operazione: 'x' }, new Error('boom'))).not.toThrow();
        expect(() => ev('email', 'info', { provider: 'resend' })).not.toThrow();
    });

    it('se appLog rigetta, la rejection non risale al chiamante', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.resetModules();
        vi.doMock('@/lib/logging/app-log', () => ({
            appLog: vi.fn(async () => { throw new Error('DB irraggiungibile'); }),
        }));
        const { logErrore: le } = await import('@/lib/logging/logger');
        expect(() => le({ operazione: 'x' }, new Error('boom'))).not.toThrow();
        // Se la rejection non fosse gestita, il processo di test morirebbe qui.
        await new Promise((r) => setTimeout(r, 0));
    });

    it('un valore ostile costa QUEL campo, non l\'intera riga — toString E getter', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { logEvento: ev } = await caricaRumoroso();

        const campi: Record<string, Valore> = {
            provider: 'resend',
            x: { toString() { throw new Error('no'); } } as unknown as Valore,
        };
        // Il getter è il caso che il test PRECEDENTE non copriva: `Object.entries` lo invoca
        // mentre costruisce l'array, quindi non basta un try dentro `quota` — il try va messo
        // attorno alla LETTURA. Un test sul solo `toString` resterebbe verde col difetto.
        Object.defineProperty(campi, 'boom', {
            enumerable: true,
            get() { throw new Error('getter ostile'); },
        });

        expect(() => ev('email', 'info', campi)).not.toThrow();
        expect(log).toHaveBeenCalledTimes(1); // la riga esce comunque
        const riga = log.mock.calls[0][0] as string;
        expect(riga).toContain('provider=resend'); // il campo sano sopravvive
        expect(riga).toContain('boom=[campo-illeggibile]'); // il getter costa solo sé stesso
        // L'oggetto non passa da `String()` (direbbe `[object Object]`, e ne invocherebbe il
        // `toString` ostile): passa da `serializza`, che non chiama `toString` e non lancia.
        expect(riga).toContain('x=');
        expect(riga).not.toContain('[object Object]');
    });

    it('la scrittura su app_log non può ricorrere (e il suo fallimento resta visibile)', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rif: { logger?: typeof import('@/lib/logging/logger') } = {};
        // Il Task 8: l'insert su Supabase fallisce, e il suo gestore d'errore logga.
        const appLog = vi.fn(async () => {
            rif.logger?.logErrore({ operazione: 'app_log' }, new Error('insert fallita'));
            throw new Error('insert fallita');
        });
        vi.resetModules();
        vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
        rif.logger = await import('@/lib/logging/logger');

        rif.logger.logErrore({ operazione: 'route-x' }, new Error('boom'));
        await new Promise((r) => setTimeout(r, 0));

        // Una sola scrittura: la persistenza rientrante è stata scartata da `inLogger()`.
        // Senza la guardia, si ricorrerebbe fino all'esaurimento della memoria.
        expect(appLog).toHaveBeenCalledTimes(1);
        // …ma la riga del fallimento interno è USCITA su console: mettere la guardia anche
        // sull'emissione renderebbe muto un `app_log` rotto proprio dove ce ne accorgeremmo.
        const righe = errSpy.mock.calls.map((c) => String(c[0]));
        expect(righe.some((r) => r.includes('rt=app_log'))).toBe(true);
        expect(righe.some((r) => r.includes('rt=route-x'))).toBe(true);
    });

    it('un errore ostile (getter che lanciano) non fa saltare la route', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { logErrore: le } = await caricaRumoroso();
        const ostile = {
            get message() { throw new Error('no'); },
            get stack() { throw new Error('no'); },
            get code() { throw new Error('no'); },
        };
        expect(() => le({ operazione: 'x' }, ostile)).not.toThrow();
    });
});
