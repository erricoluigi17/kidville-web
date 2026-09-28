import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/diary/entries — LE ROUTINE VALGONO ANCHE PER CHI SCRIVE (2026-09-28).
 *
 * Il filtro dei bottoni vive nel client, e un client si può non aggiornare: il 2026-09-08 un tablet
 * con l'app aperta dal mattino ha scritto 17 righe di bagno vuote due ore dopo un rilascio. Quindi:
 *  · una routine BASE spenta per la sede del bambino non si scrive (422 `ROUTINE_SPENTA`);
 *  · una routine della SCUOLA si scrive solo se esiste ed è attiva nella sede del bambino
 *    (422 `ROUTINE_NON_DISPONIBILE`), con un valore valido per lei (422
 *    `ROUTINE_VALORE_NON_VALIDO`);
 *  · la fotografia (nome, icona, tipo di risposta) la scrive il SERVER dalla definizione: il
 *    client manda il valore, e quello che dice di sé non conta.
 * Tutto-o-niente, come per gli orari delle attività: nessuna riga del lotto se una è rifiutata.
 */

const SEDE = 's1';
const A1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true };
const BIBERON = { id: 'e5f6a7b8', nome: 'Biberon', emoji: '🍼', risposta: 'scelta', opzioni: ['Poco', 'Tutto'], multipla: false, attiva: true };
const APPUNTO = { id: 'd0d0d0d0', nome: 'Appunto', emoji: '📝', risposta: 'testo', opzioni: [], multipla: false, attiva: true };
const SPENTA = { ...CREMA, id: 'f0f0f0f0', attiva: false };

const h = vi.hoisted(() => ({
    inserted: [] as Array<Record<string, unknown>>,
    logEvento: vi.fn(),
    config: {} as Record<string, unknown>,
    sedeDi: {} as Record<string, string | null>,
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: (tabella: string) => {
            let ids: string[] = [];
            const chain: Record<string, unknown> = {
                select: () => chain, eq: () => chain, gte: () => chain, lte: () => chain, is: () => chain,
                in: (_c: string, v: string[]) => { ids = v; return chain; },
                order: () => chain, limit: () => chain,
                then: (r: (v: unknown) => void) => r({
                    data: tabella === 'alunni' ? ids.map((id) => ({ id, scuola_id: h.sedeDi[id] ?? null })) : [],
                    error: null,
                }),
                insert: (row: Record<string, unknown>) => {
                    h.inserted.push(row);
                    return { select: () => ({ then: (r: (v: unknown) => void) => r({ data: [{ id: 'x', alunno_id: row.alunno_id, tipo_evento: row.tipo_evento }], error: null }) }) };
                },
                update: () => chain, maybeSingle: async () => ({ data: null, error: null }),
            };
            return chain;
        },
    }),
}));
vi.mock('@/lib/auth/require-staff', () => ({
    requireDocente: async () => ({ user: { id: 'u1', ruolo: 'educator', scuola_id: SEDE }, response: null }),
    requireStaff: async () => ({ user: { id: 'u1', ruolo: 'educator', scuola_id: SEDE }, response: null }),
}));
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }));
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(), enqueueDiarioGenitori: vi.fn() }));
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => h.config, leggiModuleConfig: async () => ({ ok: true, config: h.config }) }));
vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: vi.fn() }));
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null, resolveScuoleAttive: async () => [SEDE] }));
vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<Record<string, unknown>>()), logEvento: h.logEvento }));

const req = (body: unknown) => new NextRequest('http://x/api/diary/entries?userId=u1', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify(body),
});
const voce = (alunno: string, tipo: string, dettagli: Record<string, unknown>) =>
    ({ alunno_id: alunno, maestra_id: 'u1', tipo_evento: tipo, orario_inizio: new Date().toISOString(), dettagli });

beforeEach(() => {
    h.inserted = []; h.logEvento.mockClear();
    h.config = { routine_attive: ['pasto', 'cambio'], routine_personalizzate: [CREMA, BIBERON, APPUNTO, SPENTA] };
    h.sedeDi = { [A1]: SEDE, [B2]: SEDE };
});

async function post(body: unknown) {
    const { POST } = await import('@/app/api/diary/entries/route');
    const res = await POST(req(body));
    return { res, body: await res.json() };
}

describe('POST /api/diary/entries — routine della scuola', () => {
    it('si scrive con la fotografia della DEFINIZIONE: quello che il client dice di sé non conta', async () => {
        const { res } = await post([voce(A1, 'routine:a1b2c3d4', { nome: 'Nome falso', emoji: '💣', risposta: 'testo', valore: true })]);
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(1);
        expect(h.inserted[0].dettagli).toEqual({ nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', valore: true });
    });

    it('il testo libero si salva senza spazi ai bordi', async () => {
        await post([voce(A1, 'routine:d0d0d0d0', { valore: '  ha dormito in braccio  ' })]);
        expect(h.inserted[0].dettagli).toMatchObject({ valore: 'ha dormito in braccio' });
    });

    it('una routine che la sede non ha, o che ha spento, non si scrive: 422 e nessuna riga', async () => {
        for (const tipo of ['routine:99999999', 'routine:f0f0f0f0', 'routine:NON-VALIDO']) {
            h.inserted = [];
            const { res, body } = await post([voce(A1, 'routine:a1b2c3d4', { valore: true }), voce(B2, tipo, { valore: true })]);
            expect(res.status, tipo).toBe(422);
            expect(body.codice, tipo).toBe('ROUTINE_NON_DISPONIBILE');
            expect(h.inserted, `${tipo}: il lotto è tutto-o-niente`).toHaveLength(0);
        }
    });

    it('un valore che non vale per la routine non si scrive: 422', async () => {
        const { res, body } = await post([voce(A1, 'routine:e5f6a7b8', { valore: ['Doppio'] })]);
        expect(res.status).toBe(422);
        expect(body.codice).toBe('ROUTINE_VALORE_NON_VALIDO');
        expect(h.inserted).toHaveLength(0);
    });

    it('le routine si leggono dalla sede DEL BAMBINO: senza sede, solo quelle predefinite', async () => {
        // Un bambino senza sede non ha routine della scuola: la routine esiste altrove, non per lui.
        h.sedeDi[B2] = null;
        const { res } = await post([voce(B2, 'routine:a1b2c3d4', { valore: true })]);
        expect(res.status).toBe(422);
        expect(h.inserted).toHaveLength(0);
    });

    it('il rifiuto si logga, senza nomi né valori', async () => {
        await post([voce(A1, 'routine:99999999', { valore: 'segreto' })]);
        const riga = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'routine-rifiutata');
        expect(riga).toBeTruthy();
        expect(riga?.[2]).toMatchObject({ error_code: 'ROUTINE_NON_DISPONIBILE', n_ricevute: 1 });
        expect(JSON.stringify(riga)).not.toContain('segreto');
    });
});

describe('POST /api/diary/entries — routine base spente', () => {
    it('spento il sonno, la nanna non si scrive: 422 `ROUTINE_SPENTA`', async () => {
        const { res, body } = await post([voce(A1, 'nanna_inizio', { orario_inizio: '12:30' })]);
        expect(res.status).toBe(422);
        expect(body.codice).toBe('ROUTINE_SPENTA');
        expect(h.inserted).toHaveLength(0);
    });

    it('le routine accese si scrivono come prima', async () => {
        const { res } = await post([voce(A1, 'bagno', { pipi: 1, cacca: 0, vasino: 0 }), voce(B2, 'pranzo', { corsi: { primo: 'tutto' } })]);
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(2);
    });

    it('sede che non ha mai scelto: le routine di sempre (nanna sì, umore no)', async () => {
        h.config = {};
        expect((await post([voce(A1, 'nanna_inizio', { orario_inizio: '12:30' })])).res.status).toBeLessThan(300);
        expect((await post([voce(A1, 'umore', { umore: 'felice' })])).body.codice).toBe('ROUTINE_SPENTA');
    });
});
