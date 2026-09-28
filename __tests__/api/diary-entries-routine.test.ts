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
    updated: [] as Array<Record<string, unknown>>,
    logEvento: vi.fn(),
    config: {} as Record<string, unknown>,
    sedeDi: {} as Record<string, string | null>,
    /** Le righe di OGGI già in archivio, per `alunno|tipo`. */
    esistenti: {} as Record<string, { id: string; dettagli: Record<string, unknown> }>,
    alunniRotti: false,
    /** La SELECT della riga di oggi (prima dell'upsert) fallisce. */
    rotturaRicerca: false,
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        from: (tabella: string) => {
            let ids: string[] = [];
            const filtri: Record<string, unknown> = {};
            let aggiornamento: Record<string, unknown> | null = null;
            const chain: Record<string, unknown> = {
                select: () => chain, gte: () => chain, lte: () => chain, is: () => chain,
                eq: (c: string, v: unknown) => { filtri[c] = v; return chain; },
                in: (_c: string, v: string[]) => { ids = v; return chain; },
                order: () => chain, limit: () => chain,
                then: (r: (v: unknown) => void) => {
                    if (aggiornamento) {
                        h.updated.push(aggiornamento);
                        return r({ data: [{ id: filtri.id, alunno_id: 'a', tipo_evento: 't' }], error: null });
                    }
                    if (tabella === 'alunni') {
                        return r(h.alunniRotti
                            ? { data: null, error: { message: 'boom', code: '57014' } }
                            : { data: ids.map((id) => ({ id, scuola_id: h.sedeDi[id] ?? null })), error: null });
                    }
                    if (h.rotturaRicerca) return r({ data: null, error: { message: 'timeout', code: '57014' } });
                    const esiste = h.esistenti[`${filtri.alunno_id}|${filtri.tipo_evento}`];
                    return r({ data: esiste ? [esiste] : [], error: null });
                },
                insert: (row: Record<string, unknown>) => {
                    h.inserted.push(row);
                    return { select: () => ({ then: (r: (v: unknown) => void) => r({ data: [{ id: 'x', alunno_id: row.alunno_id, tipo_evento: row.tipo_evento }], error: null }) }) };
                },
                update: (row: Record<string, unknown>) => { aggiornamento = row; return chain; },
                maybeSingle: async () => ({ data: null, error: null }),
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
const voce = (alunno: string, tipo: string, dettagli: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ alunno_id: alunno, maestra_id: 'u1', tipo_evento: tipo, orario_inizio: new Date().toISOString(), dettagli, ...extra });

beforeEach(() => {
    h.inserted = []; h.updated = []; h.logEvento.mockClear();
    h.esistenti = {}; h.alunniRotti = false; h.rotturaRicerca = false;
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
        for (const tipo of ['routine:99999999', 'routine:f0f0f0f0']) {
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

describe('POST /api/diary/entries — seconda revisione critica (2026-09-28)', () => {
    it('un lotto di sole voci MUTE di una routine spenta si salta, non si rifiuta', async () => {
        // Il commento della rotta promette «le mute si SALTANO»: con il sonno spento, un bundle
        // vecchio che manda nanne vuote prendeva invece un 422 per tutto il lotto.
        const { res } = await post([voce(A1, 'nanna_inizio', { orario_inizio: '' }), voce(B2, 'routine:f0f0f0f0', { valore: null })]);
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(0);
        expect(h.logEvento.mock.calls.some((c) => c[2]?.esito === 'routine-rifiutata'), 'rifiutato').toBe(false);
        expect(h.logEvento.mock.calls.some((c) => c[2]?.esito === 'voci-mute-saltate'), 'saltate senza dirlo').toBe(true);
    });

    it.each([
        ['spunta spenta', 'routine:a1b2c3d4', false],
        ['scelta vuota', 'routine:e5f6a7b8', []],
        ['testo vuoto', 'routine:d0d0d0d0', '   '],
    ])('%s con una nota: si salva col valore `null`, non un 422 sul lotto', async (_caso, tipo, valore) => {
        const { res } = await post([voce(A1, tipo, { valore }, { nota_bambino: 'oggi niente' })]);
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(1);
        expect((h.inserted[0].dettagli as Record<string, unknown>).valore).toBeNull();
    });

    it.each(['Routine:a1b2c3d4', 'routine:NON-VALIDO', 'BAGNO', 'bagno ', 'pallone', ''])('il tipo di voce è un vocabolario chiuso: «%s» → 400', async (tipo) => {
        const { res } = await post([voce(A1, tipo, { pipi: 1 })]);
        expect(res.status).toBe(400);
        expect(h.inserted).toHaveLength(0);
    });

    it('se gli alunni non si leggono, le routine BASE passano (fail-open) e quelle della scuola no (503)', async () => {
        h.alunniRotti = true;
        expect((await post([voce(A1, 'bagno', { pipi: 1 })])).res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(1);
        h.inserted = [];
        const { res, body } = await post([voce(A1, 'routine:a1b2c3d4', { valore: true })]);
        expect(res.status).toBe(503);
        expect(body.codice).toBe('ROUTINE_NON_VERIFICATE');
        expect(h.inserted).toHaveLength(0);
    });

    it('con rifiuti diversi nello stesso lotto il codice non dipende dall\'ordine delle voci', async () => {
        const spenta = voce(A1, 'nanna_inizio', { orario_inizio: '12:30' });
        const assente = voce(B2, 'routine:99999999', { valore: true });
        expect((await post([spenta, assente])).body.codice).toBe('ROUTINE_SPENTA');
        expect((await post([assente, spenta])).body.codice).toBe('ROUTINE_SPENTA');
    });

    it('una voce col valore `null` (tenuta in piedi da una nota) NON cancella il valore già salvato', async () => {
        // Il caso vero: la segreteria rinomina un'opzione, la maestra riapre la routine, il valore
        // salvato non vale più e il campo è vuoto; lei aggiunge una nota e salva. Il valore si
        // toglie solo col cestino (o svuotando e salvando, che manda una DELETE).
        const salvato = { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] };
        h.esistenti[`${A1}|routine:e5f6a7b8`] = { id: 'r1', dettagli: salvato };
        const { res } = await post([voce(A1, 'routine:e5f6a7b8', { valore: null }, { nota_bambino: 'ha bevuto dal bicchiere' })]);
        expect(res.status).toBeLessThan(300);
        expect(h.updated).toHaveLength(1);
        expect(h.updated[0].dettagli).toEqual(salvato);
        expect(h.updated[0].nota_bambino).toBe('ha bevuto dal bicchiere');
    });

    it('…ma un valore nuovo sì, lo sostituisce', async () => {
        h.esistenti[`${A1}|routine:e5f6a7b8`] = { id: 'r1', dettagli: { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] } };
        await post([voce(A1, 'routine:e5f6a7b8', { valore: ['Tutto'] })]);
        expect((h.updated[0].dettagli as Record<string, unknown>).valore).toEqual(['Tutto']);
    });
});

describe('POST /api/diary/entries — terzo giro della revisione (2026-09-28)', () => {
    it('orario di soli spazi con una nota: `null`, non un 422 sul lotto; un orario con spazi ai bordi si salva pulito', async () => {
        const LATTE = { id: 'b0b0b0b0', nome: 'Latte', emoji: '🥛', risposta: 'orario', opzioni: [], multipla: false, attiva: true };
        h.config = { ...h.config, routine_personalizzate: [LATTE] };
        const { res } = await post([
            voce(A1, 'routine:b0b0b0b0', { valore: '  ' }, { nota_bambino: 'n' }),
            voce(B2, 'routine:b0b0b0b0', { valore: ' 10:30 ' }),
        ]);
        expect(res.status).toBeLessThan(300);
        expect(h.inserted.map((r) => (r.dettagli as Record<string, unknown>).valore)).toEqual([null, '10:30']);
    });

    it('il valore già salvato si tiene, ma col NOME e l\'icona di oggi (la routine può essere stata rinominata)', async () => {
        h.esistenti[`${A1}|routine:e5f6a7b8`] = { id: 'r1', dettagli: { nome: 'Biberon vecchio', emoji: '🥛', risposta: 'scelta', valore: ['Poco'] } };
        await post([voce(A1, 'routine:e5f6a7b8', { valore: null }, { nota_bambino: 'x' })]);
        expect(h.updated[0].dettagli).toEqual({ nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] });
    });

    it('`azzera_valore`: la maestra ha tolto il valore e tiene la nota — il valore se ne va davvero', async () => {
        h.esistenti[`${A1}|routine:e5f6a7b8`] = { id: 'r1', dettagli: { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] } };
        await post([voce(A1, 'routine:e5f6a7b8', { valore: null }, { nota_bambino: 'ha la pelle arrossata', azzera_valore: true })]);
        expect((h.updated[0].dettagli as Record<string, unknown>).valore).toBeNull();
        expect(h.updated[0].nota_bambino).toBe('ha la pelle arrossata');
    });

    it('se la ricerca della riga di oggi fallisce, non si scrive alla cieca un doppione: la voce va fra gli errori (207)', async () => {
        h.rotturaRicerca = true;
        const { res, body } = await post([voce(A1, 'bagno', { pipi: 1 })]);
        expect(res.status).toBe(207);
        expect(h.inserted).toHaveLength(0);
        expect(body.errors).toHaveLength(1);
    });
});

describe('POST /api/diary/entries — togliere la sola nota di un valore «non più previsto» (quinto giro)', () => {
    it('`togli_nota`: la riga esistente perde la nota e TIENE il valore; niente voce muta saltata', async () => {
        const salvato = { nome: 'Biberon', emoji: '🍼', risposta: 'scelta', valore: ['Poco'] };
        h.esistenti[`${A1}|routine:e5f6a7b8`] = { id: 'r1', dettagli: salvato };
        const { res } = await post([voce(A1, 'routine:e5f6a7b8', { valore: null }, { nota_bambino: null, togli_nota: true })]);
        expect(res.status).toBeLessThan(300);
        expect(h.updated).toEqual([{ nota_bambino: null }]);
        expect(h.logEvento.mock.calls.some((c) => c[2]?.esito === 'voci-mute-saltate')).toBe(false);
    });

    it('…e senza una riga di oggi non si inventa niente (mai un INSERT)', async () => {
        await post([voce(A1, 'routine:e5f6a7b8', { valore: null }, { nota_bambino: null, togli_nota: true })]);
        expect(h.inserted).toHaveLength(0);
        expect(h.updated).toHaveLength(0);
    });

    it('su un tipo base `togli_nota` non apre niente: la voce resta muta e si salta', async () => {
        h.esistenti[`${A1}|bagno`] = { id: 'b1', dettagli: { pipi: 1 } };
        await post([voce(A1, 'bagno', { pipi: 0, cacca: 0, vasino: 0 }, { togli_nota: true })]);
        expect(h.updated).toHaveLength(0);
    });
});

