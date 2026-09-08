import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * IL SERVER NON SCRIVE PIÙ UNA VOCE CHE NON DICE NIENTE.
 *
 * ─── PERCHÉ NON BASTAVA IL FILTRO NEL CLIENT, e lo dice una misura ─────────
 * Il 2026-09-08, DUE ORE dopo il rilascio del salvataggio selettivo, una
 * maestra ha scritto 19 righe di bagno di cui **17 vuote e senza note**: il suo
 * tablet aveva l'app aperta da stamattina e stava ancora eseguendo il bundle
 * di prima. Tre colleghe, nella stessa finestra, ne hanno scritte zero.
 *
 * Un filtro che vive solo nel client vale finché il client è aggiornato — e in
 * una WebView aperta tutto il giorno non lo è. La regola va dove nessuno può
 * scavalcarla: nella rotta che possiede la tabella.
 *
 * NON è una validazione che RIFIUTA: la richiesta resta valida e le altre righe
 * si salvano. Le voci mute si SALTANO, e il salto si logga — perché «17 righe
 * non scritte» in silenzio sarebbe il guasto opposto.
 */

const h = vi.hoisted(() => ({
    inserted: [] as Array<Record<string, unknown>>,
    logEvento: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: () => {
            const chain: Record<string, unknown> = {
                select: () => chain, eq: () => chain, gte: () => chain, lte: () => chain, in: () => chain, is: () => chain,
                order: () => chain, limit: () => chain,
                then: (r: (v: unknown) => void) => r({ data: [], error: null }),
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
    requireDocente: async () => ({ user: { id: 'u1', ruolo: 'educator', scuola_id: 's1' }, response: null }),
    requireStaff: async () => ({ user: { id: 'u1', ruolo: 'educator', scuola_id: 's1' }, response: null }),
}));
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }));
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(), enqueueDiarioGenitori: vi.fn() }));
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }));
vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: vi.fn() }));
vi.mock('@/lib/auth/scope', () => ({
    assertAlunnoInScope: async () => null,
    resolveScuoleAttive: async () => ['s1'],
}));
vi.mock('@/lib/logging/logger', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    logEvento: h.logEvento,
}));

const req = (body: unknown) => new NextRequest('http://x/api/diary/entries?userId=u1', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify(body),
});

const voce = (alunno: string, tipo: string, dettagli: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ alunno_id: alunno, maestra_id: 'u1', tipo_evento: tipo, orario_inizio: new Date().toISOString(), dettagli, ...extra });

const A1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { h.inserted = []; h.logEvento.mockClear(); });

describe('POST /api/diary/entries — la voce muta non entra in archivio', () => {
    it('un client VECCHIO manda tutta la sezione: il server scrive solo chi ha una registrazione', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([
            voce(A1, 'bagno', { pipi: 1, cacca: 0, vasino: 0 }),
            voce(B2, 'bagno', { pipi: 0, cacca: 0, vasino: 0 }),
        ]));
        expect(res.status).toBeLessThan(300);
        expect(h.inserted.map(r => r.alunno_id)).toEqual([A1]);
    });

    it('una NOTA tiene in piedi la voce anche senza contatori', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        await POST(req([voce(B2, 'bagno', { pipi: 0, cacca: 0, vasino: 0 }, { nota_bambino: 'oggi era stanca' })]));
        expect(h.inserted.map(r => r.alunno_id)).toEqual([B2]);
    });

    it('«niente» a pranzo È una registrazione e passa', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        await POST(req([voce(A1, 'pranzo', { corsi: { primo: 'niente' } })]));
        expect(h.inserted).toHaveLength(1);
    });

    it('un tipo senza regola passa comunque: il server non inventa filtri', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        await POST(req([voce(A1, 'entrata', {})]));
        expect(h.inserted).toHaveLength(1);
    });

    it('le voci saltate si LOGGANO: «17 righe non scritte» in silenzio sarebbe il guasto opposto', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        await POST(req([
            voce(A1, 'bagno', { pipi: 0, cacca: 0, vasino: 0 }),
            voce(B2, 'bagno', { pipi: 0, cacca: 0, vasino: 0 }),
        ]));
        const riga = h.logEvento.mock.calls.find(c => c[2]?.esito === 'voci-mute-saltate');
        expect(riga).toBeTruthy();
        expect(riga?.[2]).toMatchObject({ n_saltate: 2, n_ricevute: 2 });
    });
});
