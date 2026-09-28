import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * GET /api/diary/config — LE ROUTINE DELLA SEDE CHE SI STA COMPILANDO (2026-09-28).
 *
 * Due difetti, trovati prima di rendere le routine funzionanti:
 *  · ASSENTE diventava VUOTA: senza `routine_attive` la rotta rispondeva `[]`, e da oggi una
 *    lista vuota vuol dire «tutto spento». Una sede nuova (nasce con `diario_config = {}`) avrebbe
 *    perso tutti i bottoni. Ora l'assenza è `null`.
 *  · LA SEDE ERA SEMPRE QUELLA DELL'UTENTE: il cockpit di segreteria che compila il diario di un
 *    altro plesso leggeva le routine del proprio. Ora si può chiedere la sede, e si valida.
 */

const SEDE_MIA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SEDE_ALTRA = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SEDE_NON_MIA = 'cccccccc-0000-4000-8000-00000000000c';

const h = vi.hoisted(() => ({
    configPerSede: {} as Record<string, Record<string, unknown>>,
    sedeLetta: null as string | null,
    sediUtente: [] as string[],
    logEvento: vi.fn(),
    rotta: false,
}));
vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<Record<string, unknown>>()), logEvento: h.logEvento }));

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({}) }));
vi.mock('@/lib/auth/require-staff', () => ({
    requireDocente: async () => ({ user: { id: 'u1', role: 'admin', scuola_id: SEDE_MIA }, response: null }),
}));
vi.mock('@/lib/auth/scope', async (orig) => ({ ...(await orig<Record<string, unknown>>()), scuoleDiUtente: async () => h.sediUtente }));
vi.mock('@/lib/settings/module-config', () => ({
    getModuleConfig: async (_s: unknown, _k: string, sede: string) => { h.sedeLetta = sede; return h.configPerSede[sede] ?? {}; },
    leggiModuleConfig: async (_s: unknown, _k: string, sede: string) => {
        h.sedeLetta = sede;
        return h.rotta ? { ok: false } : { ok: true, config: h.configPerSede[sede] ?? {} };
    },
}));

const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true };
const SPENTA = { ...CREMA, id: 'f0f0f0f0', nome: 'Spenta', attiva: false };

const req = (qs = '') => new NextRequest(`http://x/api/diary/config${qs}`);

beforeEach(() => {
    h.configPerSede = {};
    h.sedeLetta = null;
    h.sediUtente = [SEDE_MIA, SEDE_ALTRA];
    h.logEvento.mockClear();
    h.rotta = false;
});

describe('GET /api/diary/config — le routine', () => {
    it('sede senza scelta: `routine_attive` è null (non `[]`, che vuol dire tutto spento)', async () => {
        h.configPerSede[SEDE_MIA] = {};
        const { GET } = await import('@/app/api/diary/config/route');
        const body = await (await GET(req())).json();
        expect(body.routine_attive).toBeNull();
        expect(body.routine_personalizzate).toEqual([]);
    });

    it('le routine della scuola escono solo ATTIVE e valide', async () => {
        h.configPerSede[SEDE_MIA] = { routine_attive: ['cambio'], routine_personalizzate: [CREMA, SPENTA, { id: 'rotta' }] };
        const { GET } = await import('@/app/api/diary/config/route');
        const body = await (await GET(req())).json();
        expect(body.routine_attive).toEqual(['cambio']);
        expect(body.routine_personalizzate.map((r: { id: string }) => r.id)).toEqual(['a1b2c3d4']);
    });

    it('la sede chiesta, se è fra le sue, è quella che si legge', async () => {
        h.configPerSede[SEDE_ALTRA] = { routine_attive: ['pasto'] };
        const { GET } = await import('@/app/api/diary/config/route');
        const body = await (await GET(req(`?scuola_id=${SEDE_ALTRA}`))).json();
        expect(h.sedeLetta).toBe(SEDE_ALTRA);
        expect(body.routine_attive).toEqual(['pasto']);
    });

    it('presidio — una sede che non è sua non si legge: 403', async () => {
        const { GET } = await import('@/app/api/diary/config/route');
        const res = await GET(req(`?scuola_id=${SEDE_NON_MIA}`));
        expect(res.status).toBe(403);
        expect(h.sedeLetta).toBeNull();
    });

    it('il 403 si logga (warn, persistito): una sede chiesta e non posseduta è un segnale', async () => {
        const { GET } = await import('@/app/api/diary/config/route');
        await GET(req(`?scuola_id=${SEDE_NON_MIA}`));
        const riga = h.logEvento.mock.calls.find((c) => c[2]?.tipo === 'sede-dichiarata-fuori-scope');
        expect(riga?.[1]).toBe('warn');
        expect(riga?.[2]).toMatchObject({ azione: 'diary/config:GET', utente: 'u1' });
    });
});

describe('GET /api/diary/config — un guasto non si traveste da «la sede non ha mai scelto»', () => {
    it('configurazione illeggibile: 503 `ROUTINE_NON_VERIFICATE`, non le routine predefinite senza quelle della scuola', async () => {
        h.rotta = true;
        const { GET } = await import('@/app/api/diary/config/route');
        const res = await GET(req());
        expect(res.status).toBe(503);
        expect((await res.json()).codice).toBe('ROUTINE_NON_VERIFICATE');
    });
});
