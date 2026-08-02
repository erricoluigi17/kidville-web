import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * IL RUMORE CHE ACCECA, e la riga di successo che non deve pagarlo.
 *
 * Due difetti misurati dal collaudo del 2026-07-31, che si toccano in un punto solo — il
 * `fetch` strumentato dei client Supabase.
 *
 * W1. Una sola `GET /api/avvisi` con 9 avvisi ha prodotto **35 righe** di log, 34 delle quali
 *     `evt=db … lenta=true` (l'N+1 del cockpit: una HEAD di conteggio e una GET utenti per
 *     avviso). La testata di `logger.ts` dichiara «1-2 righe per richiesta, non dieci» perché
 *     una lettura dei log di Vercel ne restituisce 100: una singola apertura della bacheca ne
 *     mangiava un terzo. Il danno non è la tabella (le lente sono `info`): è su Vercel, cioè
 *     esattamente il canale su cui si guarda un incidente MENTRE sta succedendo.
 *
 * W7+F1. Gli upload di allegati non avevano un successo persistito, e l'evento `storage` non
 *     era in `EVENTI_PERSISTITI`. Aggiungerlo (2026-08-01) chiude quel buco e ne apre un altro,
 *     se nessuno lo tiene: `storage` è ANCHE un'area di `supabase-fetch`, che emette `info` ad
 *     alto volume. Fino a ieri quelle righe restavano fuori dalla tabella per un accidente —
 *     nessuna delle cinque aree era in allowlist — non per una regola.
 *
 * Qui si collauda la regola che le tiene fuori PER DAVVERO, e il tetto che rende il rumore
 * limitato dal progetto invece che dalla fortuna.
 */

type Riga = { livello: string; evento: string; messaggio: string; [k: string]: unknown };

/**
 * `SILENZIOSO` è valutata al caricamento di `logger.ts`: l'unico modo di osservare ciò che il
 * logger scriverebbe in produzione è ricaricare il registry con `VITEST` non definita. `app-log`
 * è mockato perché `.env.local` punta al DB di PRODUZIONE: senza il mock questi test ci
 * scriverebbero dentro.
 */
async function caricaRumoroso() {
    const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {});
    vi.resetModules();
    vi.doMock('@/lib/logging/app-log', () => ({ appLog }));
    const fetchStrumentato = await import('@/lib/logging/supabase-fetch');
    const context = await import('@/lib/logging/context');
    const logger = await import('@/lib/logging/logger');
    return { ...fetchStrumentato, ...context, ...logger, appLog };
}

function risposta(corpo: string, stato: number): Response {
    return new Response(corpo, { status: stato, headers: { 'content-type': 'application/json' } });
}

const STORAGE = 'https://x.supabase.co/storage/v1/object/avvisi_allegati/1770000000000-a1b2c3.pdf';
const TABELLA = 'https://x.supabase.co/rest/v1/avvisi_risposte';

describe('supabase-fetch — gli `info` non entrano in tabella, e il rumore ha un tetto', () => {
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

    /* ── L'allowlist non deve poter aprire il rubinetto ───────────────────── */

    it('una lettura STORAGE lenta resta fuori da `app_log`, anche ora che `storage` è persistito', async () => {
        const { creaFetchStrumentato: crea, appLog, EVENTI_PERSISTITI } = await caricaRumoroso();
        // PREMESSA DEL TEST, non un dettaglio: se `storage` uscisse dall'allowlist questo test
        // diventerebbe verde per la ragione sbagliata — non perché la regola tiene, ma perché
        // non c'è più niente da tenere.
        expect(EVENTI_PERSISTITI.has('storage')).toBe(true);

        let t = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 900));
        const f = crea(async () => new Response('binario', { status: 200 }));
        await f(STORAGE);

        // La riga ESCE su Vercel: la latenza si guarda lì, e continua a vedersi.
        expect(String(log.mock.calls[0][0])).toContain('lenta=true');
        expect(String(log.mock.calls[0][0])).toContain('evt=storage');
        // …ma non si fossilizza in tabella: sarebbero migliaia di scritture verso lo stesso
        // sistema che sta rallentando.
        expect(appLog).not.toHaveBeenCalled();
    });

    it('CONTROLLO POSITIVO: un 404 dello storage invece in tabella ci arriva eccome', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        const f = crea(async () => risposta('{"error":"not_found","message":"Object not found"}', 404));
        await f(STORAGE);

        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0].livello).toBe('error');
        expect(appLog.mock.calls[0][0].evento).toBe('storage');
    });

    it('CONTROLLO POSITIVO: il `logEvento` applicativo di un upload riuscito in tabella ci arriva', async () => {
        // È la ragione per cui `storage` è entrato in allowlist: la riga del caricamento deve
        // sopravvivere alla ritenzione di Vercel. Se la regola sugli `info` di `supabase-fetch`
        // fosse scritta nel posto sbagliato (per esempio dentro `vaPersistito`), spegnerebbe
        // anche questa — e il test sopra resterebbe verde mentre il difetto torna.
        const { logEvento, appLog } = await caricaRumoroso();
        logEvento('storage', 'info', {
            operazione: 'avvisi/upload:POST', esito: 'allegato-caricato', bucket: 'avvisi_allegati',
        });
        expect(appLog).toHaveBeenCalledTimes(1);
        expect(appLog.mock.calls[0][0]).toMatchObject({ livello: 'info', evento: 'storage' });
    });

    it('un 3xx (nemmeno lui un guasto) non finisce in tabella su nessuna area', async () => {
        const { creaFetchStrumentato: crea, appLog } = await caricaRumoroso();
        await crea(async () => new Response(null, { status: 304 }))(STORAGE);
        expect(appLog).not.toHaveBeenCalled();
        expect(String(log.mock.calls[0][0])).toContain('KV_EVT');
    });

    /* ── Il tetto per richiesta ───────────────────────────────────────────── */

    it('34 query lente nella STESSA richiesta non producono 34 righe (W1: un terzo di Vercel)', async () => {
        const { creaFetchStrumentato: crea, conContesto } = await caricaRumoroso();
        let t = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 900));
        const f = crea(async () => new Response('[]', { status: 200 }));

        await conContesto({ requestId: 'r-1', path: '/api/avvisi' }, async () => {
            for (let i = 0; i < 34; i++) await f(TABELLA);
        });

        const righe: string[] = log.mock.calls.map((c: unknown[]) => String(c[0]));
        // Il criterio del piano: una `GET /api/avvisi` sta dentro 3 righe, contando anche
        // quella di esito che `withRoute` emette a parte.
        expect(righe.length).toBeLessThanOrEqual(2);
        // CONTROLLO POSITIVO: non è silenzio. La prima riga c'è, dice che è lenta e quanto.
        expect(righe[0]).toContain('lenta=true');
        expect(righe[0]).toMatch(/\bms=\d+/);
        // E il conteggio non si perde: chi legge sa che non è un caso isolato.
        expect(righe.join('\n')).toMatch(/lente=\d+/);
        expect(righe[righe.length - 1]).toContain('lente=10');
    });

    it('il tetto è PER RICHIESTA: la richiesta dopo riparte da capo, non eredita il silenzio', async () => {
        const { creaFetchStrumentato: crea, conContesto } = await caricaRumoroso();
        let t = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 900));
        const f = crea(async () => new Response('[]', { status: 200 }));

        for (const rid of ['r-1', 'r-2', 'r-3']) {
            await conContesto({ requestId: rid, path: '/api/avvisi' }, async () => {
                for (let i = 0; i < 5; i++) await f(TABELLA);
            });
        }

        const righe: string[] = log.mock.calls.map((c: unknown[]) => String(c[0]));
        // Una riga per richiesta, e ognuna porta il SUO id di correlazione: se il contatore
        // fosse di modulo (condiviso fra richieste concorrenti — ciò che le regole del contesto
        // vietano) la seconda e la terza richiesta sarebbero mute.
        for (const rid of ['r-1', 'r-2', 'r-3']) {
            expect(righe.filter((r) => r.includes(`rid=${rid}`)).length, rid).toBe(1);
        }
    });

    it('gli ERRORI non hanno tetto: il rumore si sopprime, un guasto mai', async () => {
        const { creaFetchStrumentato: crea, conContesto, appLog } = await caricaRumoroso();
        const f = crea(async () => risposta('{"code":"42P01","message":"relation does not exist"}', 404));

        await conContesto({ requestId: 'r-9', path: '/api/avvisi' }, async () => {
            for (let i = 0; i < 6; i++) await f(TABELLA, { method: 'POST' });
        });

        const righe: string[] = err.mock.calls
            .map((c: unknown[]) => String(c[0]))
            .filter((r: string) => r.startsWith('KV_ERR'));
        expect(righe).toHaveLength(6);
        expect(appLog).toHaveBeenCalledTimes(6);
    });

    it('fuori da una richiesta (cron, boot) il tetto non si applica: non c\'è una richiesta a cui appenderlo', async () => {
        // Decisione dichiarata, non dimenticanza: il contatore vive appeso all'oggetto di
        // contesto (che è per-richiesta). Un contatore di modulo sarebbe condiviso fra richieste
        // concorrenti e, non azzerandosi mai, dopo un po' renderebbe MUTO il canale per sempre.
        // Nei cron il volume è basso e nessuno sta leggendo un incidente in diretta.
        const { creaFetchStrumentato: crea } = await caricaRumoroso();
        let t = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (t += 900));
        const f = crea(async () => new Response('[]', { status: 200 }));
        for (let i = 0; i < 4; i++) await f(TABELLA);
        expect(log.mock.calls.length).toBe(4);
    });
});
