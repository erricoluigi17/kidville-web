import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LA CODA OFFLINE DELL'APPELLO PRIMARIA TRASPORTA ORARIO, NOTA E GIUSTIFICAZIONE (A4).
 *
 * Prima la POST del flush era `{ sectionId, data, alunnoId, stato }` e basta: l'ora del
 * ritardo segnata senza campo si perdeva al primo ritorno della rete. Col contratto A3
 * c'è di peggio: una POST che NON nomina `assenzaOrariaGiustificata` la SPEGNE — quindi
 * un ritardo giustificato salvato offline sarebbe arrivato al server come ritardo che
 * conta nelle ore di assenza, senza che nessuno lo vedesse.
 *
 * Il rovescio conta uguale: una riga accodata PRIMA di questa modifica (senza i campi
 * nuovi) deve partire con lo stesso corpo di sempre. Un campo `undefined` messo nel
 * corpo sarebbe innocuo in JSON, ma un `null` no: `orarioEntrata: null` CANCELLA l'ora
 * sul server, `noteAppello: null` cancella la nota.
 */

type Riga = Record<string, unknown> & { id: string; sync_status: string };

/** Finto store Dexie: `anyOf` filtra davvero per stato, `update` applica davvero. */
function creaStore() {
    const righe: Riga[] = [];
    return {
        righe,
        put: vi.fn(async (r: Riga) => {
            const i = righe.findIndex((x) => x.id === r.id);
            if (i >= 0) righe[i] = r; else righe.push(r);
        }),
        where: vi.fn((campo: string) => ({
            anyOf: (...stati: string[]) => ({
                toArray: async () => righe.filter((r) => stati.includes(String(r[campo]))),
            }),
        })),
        update: vi.fn(async (id: string, modifiche: Record<string, unknown>) => {
            const r = righe.find((x) => x.id === id);
            if (r) Object.assign(r, modifiche);
        }),
        get: vi.fn(async (id: string) => righe.find((x) => x.id === id)),
    };
}

const h = vi.hoisted(() => ({ logClient: vi.fn() }));
vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));
vi.mock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }));
vi.mock('@/lib/gallery/carica-media', () => ({ caricaMediaGalleria: vi.fn() }));

const store = vi.hoisted(() => ({ appello: null as unknown as ReturnType<typeof creaStore> }));
vi.mock('@/lib/offline/db', () => ({
    db: {
        get primaria_appello() { return store.appello; },
    },
}));

import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';
import { corpoPostAppelloDaCoda } from '@/lib/offline/coda-appello-primaria';

const SEZIONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOCENTE = 'cccccccc-0000-4000-8000-000000000003';
const ALUNNO = 'dddddddd-0000-4000-8000-000000000004';

let corpiInviati: Array<Record<string, unknown>> = [];

function presenzaInCoda(over: Record<string, unknown> = {}) {
    return {
        id: `${ALUNNO}|2026-09-09`,
        section_id: SEZIONE,
        alunno_id: ALUNNO,
        data: '2026-09-09',
        stato: 'ritardo',
        aggiornato_il: '2026-09-09T08:00:00.000Z',
        ...over,
    };
}

async function accoda(over: Record<string, unknown> = {}) {
    vi.stubGlobal('navigator', { onLine: false });
    await saveLocalAppello(presenzaInCoda(over) as never);
    vi.stubGlobal('navigator', { onLine: true });
}

beforeEach(() => {
    vi.clearAllMocks();
    store.appello = creaStore();
    corpiInviati = [];
    window.localStorage.setItem('kv_teacher_id', DOCENTE);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        corpiInviati.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200 } as Response;
    }));
});

describe('la coda dell\'appello primaria porta i campi della finestra', () => {
    it('un ritardo GIUSTIFICATO accodato arriva al server con ora, nota e flag', async () => {
        await accoda({ orario_entrata: '10:05', note_appello: 'Terapia', assenza_oraria_giustificata: true });
        await syncPendingAppello();

        expect(corpiInviati).toHaveLength(1);
        expect(corpiInviati[0]).toEqual({
            sectionId: SEZIONE,
            data: '2026-09-09',
            alunnoId: ALUNNO,
            stato: 'ritardo',
            orarioEntrata: '10:05',
            noteAppello: 'Terapia',
            assenzaOrariaGiustificata: true,
        });
        expect(store.appello.righe[0].sync_status).toBe('synced');
    });

    it('un\'uscita anticipata accodata porta l\'ora d\'USCITA e non inventa quella d\'ingresso', async () => {
        await accoda({ stato: 'uscita_anticipata', orario_uscita: '12:30', note_appello: null, assenza_oraria_giustificata: false });
        await syncPendingAppello();

        expect(corpiInviati[0]).toMatchObject({ stato: 'uscita_anticipata', orarioUscita: '12:30', assenzaOrariaGiustificata: false });
        expect(corpiInviati[0]).not.toHaveProperty('orarioEntrata');
        // `null` esplicito = «togli la nota»: è un comando, e va trasportato com'è.
        expect(corpiInviati[0]).toHaveProperty('noteAppello', null);
    });

    it('una riga VECCHIA (senza i campi nuovi) parte col corpo di sempre, senza null inventati', async () => {
        await accoda({ stato: 'presente' });
        await syncPendingAppello();

        expect(corpiInviati[0]).toEqual({ sectionId: SEZIONE, data: '2026-09-09', alunnoId: ALUNNO, stato: 'presente' });
    });

    it('corpoPostAppelloDaCoda non mette nel corpo la contabilità della coda', () => {
        const corpo = corpoPostAppelloDaCoda({
            ...presenzaInCoda({ orario_entrata: '09:00' }),
            sync_status: 'pending',
            tentativi: 2,
        } as never);
        expect(Object.keys(corpo).sort()).toEqual(['alunnoId', 'data', 'orarioEntrata', 'sectionId', 'stato']);
    });
});
