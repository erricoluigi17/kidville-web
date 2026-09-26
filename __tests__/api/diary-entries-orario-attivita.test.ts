import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/diary/entries — ORARIO DELLE ATTIVITÀ (D1, 26/09/2026).
 *
 * Ogni voce di `dettagli.activities[]` di un evento `attivita` può portare
 * `ora_inizio`/`ora_fine` ("HH:MM", facoltativi). Se ci sono entrambi, la fine
 * non può precedere l'inizio. Un orario sbagliato non si salva in silenzio: la
 * rotta risponde 422 con un messaggio italiano, PRIMA di scrivere qualsiasi riga
 * (tutto-o-niente sul lotto), e lo logga senza dati personali.
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

const req = (body: unknown) => new NextRequest('http://x/api/diary/entries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

const A1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

// Testo di fantasia: serve a controllare che NON finisca nei log.
const DESCRIZIONE = 'pittura con le foglie raccolte in giardino';

const attivita = (alunno: string, voci: Array<Record<string, unknown>>) => ({
    alunno_id: alunno,
    tipo_evento: 'attivita',
    orario_inizio: new Date().toISOString(),
    dettagli: { activities: voci },
});

const logOrario = () => h.logEvento.mock.calls.find(c => c[2]?.esito === 'orario-attivita-non-valido');

beforeEach(() => { h.inserted = []; h.logEvento.mockClear(); });

describe('POST /api/diary/entries — orario delle attività', () => {
    it('fine PRIMA dell\'inizio → 422 in italiano, nessuna riga scritta, log senza dati personali', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([
            attivita(A1, [{ tipo: 'pittura', descrizione: DESCRIZIONE, ora_inizio: '11:00', ora_fine: '10:00' }]),
        ]));
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.codice).toBe('ORARIO_ATTIVITA_INCOERENTE');
        expect(body.error).toMatch(/fine/i);
        expect(body.error).toMatch(/inizio/i);
        expect(body.details).toEqual([
            expect.objectContaining({ path: '0.dettagli.activities.0.ora_fine' }),
        ]);
        expect(h.inserted).toHaveLength(0);

        const riga = logOrario();
        expect(riga).toBeTruthy();
        expect(riga?.[0]).toBe('diary');
        // Un orario sbagliato è un avviso, non un errore del server né una nota informativa.
        expect(riga?.[1]).toBe('warn');
        expect(riga?.[2]).toMatchObject({
            operazione: 'diary/entries:POST',
            error_code: 'ORARIO_ATTIVITA_INCOERENTE',
            n_voci_non_valide: 1,
            n_ricevute: 1,
        });
        expect(JSON.stringify(riga)).not.toContain(DESCRIZIONE);
        expect(JSON.stringify(riga)).not.toContain(A1);
    });

    it('formato non HH:MM → 422 ORARIO_ATTIVITA_NON_VALIDO', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req(attivita(A1, [{ tipo: 'pittura', descrizione: DESCRIZIONE, ora_inizio: '9:30' }])));
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.codice).toBe('ORARIO_ATTIVITA_NON_VALIDO');
        expect(body.error).toMatch(/HH:MM/);
        // Corpo singolo (non array): il percorso non ha l'indice del lotto.
        expect(body.details[0].path).toBe('dettagli.activities.0.ora_inizio');
        expect(h.inserted).toHaveLength(0);
    });

    it.each([['24:00'], ['10:60'], [930], [true]])('orario %s → 422', async (v) => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([attivita(A1, [{ descrizione: DESCRIZIONE, ora_fine: v }])]));
        expect(res.status).toBe(422);
        expect((await res.json()).codice).toBe('ORARIO_ATTIVITA_NON_VALIDO');
        expect(h.inserted).toHaveLength(0);
    });

    it('formato errato + fine «dopo» l\'inizio: SOLO l\'errore di formato, nessuna incoerenza inventata', async () => {
        // '9:30' non è HH:MM: confrontarlo come stringa con '10:00' direbbe «fine prima
        // dell'inizio», che è falso (le 10:00 vengono dopo le 9:30).
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req(attivita(A1, [{ descrizione: DESCRIZIONE, ora_inizio: '9:30', ora_fine: '10:00' }])));
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.codice).toBe('ORARIO_ATTIVITA_NON_VALIDO');
        expect(body.details).toEqual([
            expect.objectContaining({ path: 'dettagli.activities.0.ora_inizio' }),
        ]);
        expect(h.inserted).toHaveLength(0);
    });

    it('precedenza: con un\'incoerenza VERA e un formato errato vince l\'incoerenza, e i details sono due', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([attivita(A1, [
            { descrizione: DESCRIZIONE, ora_inizio: '11:00', ora_fine: '10:00' },
            { descrizione: 'musica', ora_inizio: '930' },
        ])]));
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.codice).toBe('ORARIO_ATTIVITA_INCOERENTE');
        expect(body.details.map((d: { path: string }) => d.path).sort()).toEqual([
            '0.dettagli.activities.0.ora_fine',
            '0.dettagli.activities.1.ora_inizio',
        ]);
        expect(logOrario()?.[2]).toMatchObject({ error_code: 'ORARIO_ATTIVITA_INCOERENTE', n_voci_non_valide: 2 });
    });

    it('log: il conteggio è per VOCE, non per errore', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        // Una voce con inizio E fine fuori formato: due errori, una voce.
        const res1 = await POST(req([attivita(A1, [{ descrizione: DESCRIZIONE, ora_inizio: '25:00', ora_fine: '7' }])]));
        expect(res1.status).toBe(422);
        expect((await res1.json()).details).toHaveLength(2);
        expect(logOrario()?.[2]).toMatchObject({
            error_code: 'ORARIO_ATTIVITA_NON_VALIDO', n_voci_non_valide: 1, n_ricevute: 1,
        });

        h.logEvento.mockClear();
        // Due voci sbagliate (in due eventi del lotto), più una giusta.
        const res2 = await POST(req([
            attivita(A1, [{ descrizione: DESCRIZIONE, ora_inizio: '9:30' }, { descrizione: 'ok', ora_inizio: '09:30' }]),
            attivita(B2, [{ descrizione: 'musica', ora_fine: '12.30' }]),
        ]));
        expect(res2.status).toBe(422);
        expect(logOrario()?.[2]).toMatchObject({
            error_code: 'ORARIO_ATTIVITA_NON_VALIDO', n_voci_non_valide: 2, n_ricevute: 2,
        });
    });

    it('lotto: UNA voce sbagliata fra tante blocca tutto (nessuna riga a metà)', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([
            attivita(A1, [{ descrizione: DESCRIZIONE, ora_inizio: '10:00', ora_fine: '11:00' }]),
            attivita(B2, [
                { descrizione: DESCRIZIONE, ora_inizio: '10:00' },
                { descrizione: 'musica', ora_inizio: '12:00', ora_fine: '11:30' },
            ]),
        ]));
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.details.map((d: { path: string }) => d.path)).toEqual(['1.dettagli.activities.1.ora_fine']);
        expect(h.inserted).toHaveLength(0);
    });

    it('orario valido: si salva e i campi arrivano in dettagli come inviati', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const voci = [
            { tipo: 'pittura', descrizione: DESCRIZIONE, partecipazione: 'entusiasta', ora_inizio: '10:00', ora_fine: '11:00' },
            { tipo: 'musica', descrizione: 'canti', ora_inizio: '11:00', ora_fine: '11:00' }, // fine = inizio: ammesso
            { tipo: 'gioco', descrizione: 'giardino', ora_fine: '12:30' },                   // solo fine
            { tipo: 'lettura', descrizione: 'fiaba', ora_inizio: '', ora_fine: null },      // campi vuoti
            { tipo: 'altro', descrizione: 'merenda condivisa' },                            // senza orario
        ];
        const res = await POST(req([attivita(A1, voci)]));
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(1);
        expect(h.inserted[0].dettagli).toEqual({ activities: voci });
        expect(logOrario()).toBeUndefined();
    });

    it('la regola vale SOLO per le attività: gli altri tipi non vengono toccati', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([{
            alunno_id: A1, tipo_evento: 'entrata', orario_inizio: new Date().toISOString(),
            dettagli: { activities: [{ ora_inizio: '99:99', ora_fine: '00:00' }] },
        }]));
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(1);
    });

    it('forme che la rotta accettava prima restano accettate (activities non array, voce non oggetto, dettagli array)', async () => {
        const { POST } = await import('@/app/api/diary/entries/route');
        const res = await POST(req([
            { alunno_id: A1, tipo_evento: 'attivita', dettagli: { activities: [{ descrizione: DESCRIZIONE }, 'x', null] } },
            // Senza voci compilate queste due sarebbero «mute» e saltate (regola preesistente
            // di voceDaMostrare): la nota le fa scrivere, così si vede che l'orario non le tocca.
            { alunno_id: A1, tipo_evento: 'attivita', dettagli: { activities: 'pittura' }, nota_bambino: 'ok' },
            { alunno_id: B2, tipo_evento: 'attivita', dettagli: [{ descrizione: DESCRIZIONE }, 'x'], nota_bambino: 'ok' },
        ]));
        expect(res.status).toBeLessThan(300);
        expect(h.inserted).toHaveLength(3);
        expect(h.inserted[2].dettagli).toEqual([{ descrizione: DESCRIZIONE }, 'x']);
        expect(logOrario()).toBeUndefined();
    });
});
