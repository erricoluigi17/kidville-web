import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SEDE_A } from '../fixtures/sedi';

/**
 * DUE SEGNALI DIVERSI DEVONO RESTARE DUE RIGHE — e il `sede_id` della pubblicazione
 * deve arrivarci davvero.
 *
 * PERCHÉ ESISTE QUESTO FILE (collaudo `tester-opus-log` del 2026-07-31, difetto F1).
 *
 * L'audit multi-sede ha aggiunto 18 log che passano `tipo:` (`classe-fuori-sede`,
 * `sedi-attive-non-accessibili`, `genitore-fuori-sede`…) e NON passano `esito:`.
 * `testoEvento()` non guardava `tipo`, quindi `app_log.messaggio` diventava il nome NUDO
 * dell'evento — la stringa `"auth"` su diciassette righe diverse. E poiché `messaggio`
 * entra nell'IMPRONTA mentre `contesto` no, due segnali diversi sulla stessa
 * route+utente+giorno collassavano in UNA riga sola: `ON CONFLICT (fingerprint, giorno)
 * DO UPDATE SET occorrenze = occorrenze + n` sommava il contatore e teneva il `contesto`
 * della PRIMA. Del secondo evento non restava traccia, e la riga sopravvissuta
 * attribuiva l'accaduto alla causa sbagliata.
 *
 * Misurato in produzione il 2026-07-31, prima della correzione:
 *
 *   evento | livello | messaggio |          route          | occorrenze | contesto.tipo
 *   auth   | warn    | "auth"    | /api/diary/students     |     5      | classe-fuori-sede
 *   auth   | warn    | "auth"    | /api/admin/dashboard    |     1      | sedi-attive-non-accessibili
 *
 * Una riga che MENTE è peggio di una riga che manca: sulla prima ci si crede.
 *
 * COME SI TESTA. Come in `logging-app-log.test.ts`: `carica()` ricarica il grafo del
 * logging con `VITEST=''`, cioè con la guardia SILENZIOSO spenta, ma con `createLogClient`
 * mockato — si vede la riga vera senza toccare nessun database (`.env.local` punta a
 * PRODUZIONE). Contesto, logger e sink vanno presi dallo STESSO grafo ricaricato: dopo un
 * `resetModules` un `conContesto` importato staticamente scriverebbe su un'altra istanza
 * di AsyncLocalStorage e il sink non vedrebbe nulla.
 */

const rpc = vi.fn();
const createLogClient = vi.fn(async () => ({ rpc }));

vi.mock('@/lib/supabase/server-client', () => ({
    createLogClient: () => createLogClient(),
}));

type Modulo = typeof import('@/lib/logging/app-log') & typeof import('@/lib/logging/context')
    & typeof import('@/lib/logging/logger');

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

/** Tutte le righe spedite alla RPC, in ordine di emissione. */
function righeSpedite(): Record<string, unknown>[] {
    return rpc.mock.calls.flatMap(([nome, args]) => {
        expect(nome).toBe('app_log_registra');
        return (args as { righe: Record<string, unknown>[] }).righe;
    });
}

/**
 * La tabella `app_log` come la produrrebbe il DB: chiave unica `(fingerprint, giorno)`,
 * `ON CONFLICT DO UPDATE SET occorrenze = occorrenze + excluded.occorrenze`. Il `DO UPDATE`
 * NON tocca `messaggio` né `contesto`: sopravvivono quelli della PRIMA occorrenza.
 * (Semantica verificata su `supabase/migrations/20260713090000_app_log.sql`.)
 */
function comeInTabella(): { messaggio: string; occorrenze: number; tipo: unknown }[] {
    const tabella = new Map<string, { messaggio: string; occorrenze: number; tipo: unknown }>();
    for (const r of righeSpedite()) {
        const chiave = String(r.fingerprint);
        const esistente = tabella.get(chiave);
        if (esistente) {
            esistente.occorrenze += 1;
            continue;
        }
        const ctx = r.contesto as { campi?: Record<string, unknown> } | undefined;
        tabella.set(chiave, {
            messaggio: String(r.messaggio),
            occorrenze: 1,
            tipo: ctx?.campi?.tipo,
        });
    }
    return [...tabella.values()];
}

const UTENTE = '11111111-2222-3333-4444-555555555555';

/** Le due chiamate che in produzione sono collassate in una riga sola. */
async function iDueSegnaliDelDiario(m: Modulo): Promise<void> {
    await m.conContesto({ requestId: 'r1', path: '/api/diary/students' }, async () => {
        m.impostaUtente({ userId: UTENTE, ruolo: 'educator', scuolaId: SEDE_A });
        m.logEvento('auth', 'warn', {
            tipo: 'classe-fuori-sede', azione: 'assertClasseNomeInScope',
            utente: UTENTE, ruolo: 'educator', sezione: 'Sezione A',
        });
        await Promise.resolve();
    });
    await m.conContesto({ requestId: 'r2', path: '/api/diary/students' }, async () => {
        m.impostaUtente({ userId: UTENTE, ruolo: 'educator', scuolaId: SEDE_A });
        m.logEvento('auth', 'warn', {
            tipo: 'sedi-attive-non-accessibili', azione: 'resolveScuoleAttive',
            utente: UTENTE, ruolo: 'educator', selezionate: 2, accessibili: 1,
        });
        await Promise.resolve();
    });
}

let spiaLog: ReturnType<typeof vi.spyOn>;
let spiaErr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 1, error: null });
    createLogClient.mockClear();
    spiaLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    spiaErr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    spiaLog.mockRestore();
    spiaErr.mockRestore();
});

/* ════════════════════════════════════════════════════════════════════════════
 * F1 — il `tipo` è ciò che distingue il segnale: deve stare nel `messaggio`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('il messaggio della riga persistita dice QUALE segnale è', () => {
    it('un evento con `tipo` e senza `esito` non scrive più il nome NUDO dell\'evento', async () => {
        const m = await carica();
        m.logEvento('auth', 'warn', {
            tipo: 'classe-fuori-sede', azione: 'assertClasseNomeInScope', utente: UTENTE,
        });
        await Promise.resolve();

        const [riga] = righeSpedite();
        expect(riga.evento).toBe('auth');
        // Il difetto: `messaggio === 'auth'`, cioè la colonna che si legge per prima non
        // diceva niente su diciassette righe diverse.
        expect(riga.messaggio).toBe('classe-fuori-sede');
    });

    it('`esito` vince ancora su `tipo` (i chiamanti che passano entrambi non cambiano)', async () => {
        const m = await carica();
        // `mensa/alternative:POST` passa entrambi: `esito` è l'esito dell'operazione,
        // `tipo` la sua categoria. Se l'ordine si invertisse, cambierebbe il messaggio di
        // righe che oggi sono corrette — e nessuno se ne accorgerebbe.
        m.logEvento('mensa', 'warn', { tipo: 'alternativa-salvata', esito: 'salvata' });
        await Promise.resolve();
        expect(righeSpedite()[0].messaggio).toBe('salvata');
    });

    it('`operazione` vince su `tipo`: la riga di `withRoute` continua a dire la ROTTA', async () => {
        const m = await carica();
        // `agenda:POST` logga `{ operazione, esito, tipo: body.tipo }` — lì `tipo` è il tipo
        // dell'evento di agenda (un dato del body), non la categoria del segnale: se
        // vincesse, il messaggio direbbe "uscita" invece del nome della rotta.
        m.logEvento('notifica', 'error', {
            operazione: 'agenda:POST', esito: undefined, tipo: 'uscita',
        }, new Error('boom'));
        await Promise.resolve();
        // Con un errore vince comunque il messaggio dell'errore…
        expect(righeSpedite()[0].messaggio).toBe('boom');

        rpc.mockClear();
        m.logEvento('route', 'error', { operazione: 'admin/students:POST', stato: 500, ms: 3 });
        await Promise.resolve();
        expect(righeSpedite()[0].messaggio).toBe('admin/students:POST');
    });
});

describe('due segnali DIVERSI sulla stessa route non collassano in una riga sola', () => {
    it('producono due impronte diverse', async () => {
        const m = await carica();
        await iDueSegnaliDelDiario(m);

        const righe = righeSpedite();
        expect(righe).toHaveLength(2);
        expect(righe[0].fingerprint).not.toBe(righe[1].fingerprint);
    });

    it('in tabella restano DUE righe, ciascuna col proprio tipo (era una sola, col tipo sbagliato)', async () => {
        const m = await carica();
        await iDueSegnaliDelDiario(m);

        // È la prova del difetto: col bug rimesso questo array ha UN elemento solo,
        // `messaggio: 'auth'`, `occorrenze: 2`, e `tipo: 'classe-fuori-sede'` — cioè la riga
        // attribuisce ANCHE il secondo evento alla causa del primo.
        expect(comeInTabella()).toEqual([
            { messaggio: 'classe-fuori-sede', occorrenze: 1, tipo: 'classe-fuori-sede' },
            { messaggio: 'sedi-attive-non-accessibili', occorrenze: 1, tipo: 'sedi-attive-non-accessibili' },
        ]);
    });

    it('lo STESSO segnale ripetuto continua a collassare (la deduplica non si rompe)', async () => {
        const m = await carica();
        for (let i = 0; i < 3; i++) {
            await m.conContesto({ requestId: `r${i}`, path: '/api/diary/students' }, async () => {
                m.impostaUtente({ userId: UTENTE, ruolo: 'educator', scuolaId: SEDE_A });
                m.logEvento('auth', 'warn', {
                    tipo: 'classe-fuori-sede', azione: 'assertClasseNomeInScope',
                    utente: UTENTE, ruolo: 'educator', sezione: 'Sezione A',
                });
                await Promise.resolve();
            });
        }
        expect(comeInTabella()).toEqual([
            { messaggio: 'classe-fuori-sede', occorrenze: 3, tipo: 'classe-fuori-sede' },
        ]);
    });

    it('i CONTATORI che variano a ogni richiesta NON entrano nell\'impronta', async () => {
        // Se per separare i segnali si fosse messo il `contesto` nell'impronta invece del
        // `messaggio`, `accessibili`/`selezionate`/`ms` — che cambiano a ogni richiesta —
        // avrebbero prodotto una riga nuova ogni volta: la deduplica sarebbe morta e
        // `app_log` sarebbe tornata a essere N righe identiche. È il motivo per cui la
        // correzione sta in `testoEvento`, non in `impronta`.
        const m = await carica();
        for (const accessibili of [1, 2, 3]) {
            await m.conContesto({ requestId: 'r', path: '/api/admin/dashboard' }, async () => {
                m.impostaUtente({ userId: UTENTE, ruolo: 'admin', scuolaId: SEDE_A });
                m.logEvento('auth', 'warn', {
                    tipo: 'sedi-attive-non-accessibili', azione: 'resolveScuoleAttive',
                    utente: UTENTE, ruolo: 'admin', selezionate: 3, accessibili,
                });
                await Promise.resolve();
            });
        }
        expect(comeInTabella()).toEqual([
            { messaggio: 'sedi-attive-non-accessibili', occorrenze: 3, tipo: 'sedi-attive-non-accessibili' },
        ]);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * W3 — gli eventi di PUBBLICAZIONE arrivano in tabella, col loro `scuola_id`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('la pubblicazione arriva in `app_log` e dice in quale sede', () => {
    it('`galleria` info è persistito e porta la sede in COLONNA', async () => {
        const m = await carica();
        await m.conContesto({ requestId: 'r', path: '/api/gallery' }, async () => {
            m.impostaUtente({ userId: UTENTE, ruolo: 'educator', scuolaId: SEDE_A });
            m.logEvento('galleria', 'info', {
                operazione: 'gallery:POST', esito: 'pubblicata', sede: SEDE_A,
            });
            await Promise.resolve();
        });

        const [riga] = righeSpedite();
        expect(riga.evento).toBe('galleria');
        expect(riga.messaggio).toBe('pubblicata');
        // La domanda operativa vera: «in quale sede abbiamo pubblicato ieri?».
        expect(riga.scuola_id).toBe(SEDE_A);
    });

    it('`modulistica` e `multi_sede` info sono persistiti', async () => {
        const m = await carica();
        m.logEvento('modulistica', 'info', {
            operazione: 'forms/submit:POST', esito: 'compilazione-registrata',
        });
        m.logEvento('multi_sede', 'info', {
            operazione: 'admin/schools:POST', esito: 'admin-collaudo-esclusi',
        });
        await Promise.resolve();
        expect(righeSpedite().map((r) => r.evento)).toEqual(['modulistica', 'multi_sede']);
    });

    it('`auth` info NON è persistito: sono i 401/403 dei gate, non un segnale', async () => {
        // `require-staff.ts` logga OGNI rifiuto del gate come `auth` info, e `supabase-fetch`
        // logga come `auth` info ogni risposta non-ok di GoTrue (401 a sessione scaduta,
        // 400 refresh token invalido). Persistirli riempirebbe `app_log` di rumore — è la
        // stessa ragione per cui `route` non è in allowlist (design §6). Gli `auth` che
        // servono all'audit sono `warn`/`error`: si persistono già per livello.
        const m = await carica();
        m.logEvento('auth', 'info', { tipo: 'gate-negato', azione: 'requireStaff', ruolo: 'parent' });
        await Promise.resolve();
        expect(rpc).not.toHaveBeenCalled();

        m.logEvento('auth', 'warn', { tipo: 'genitore-fuori-sede', azione: 'assertParentInScope' });
        await Promise.resolve();
        expect(righeSpedite()).toHaveLength(1);
    });
});
