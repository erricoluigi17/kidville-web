import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Appello PRIMARIA — correggere un'ora non deve cancellare la nota, né l'altra ora.
 *
 * ─── IL DIFETTO, che era in produzione ────────────────────────────────────────
 *
 * Questa schermata non aveva un PATCH: ogni gesto rispediva una POST, e la POST è un
 * **upsert della riga intera**. `setOrario` mandava stato e orari ma non `noteAppello`,
 * quindi correggere un'ora cancellava la nota che il docente aveva scritto su quel
 * giorno. Nessun errore, nessun log: il dato spariva.
 *
 * Il server ora conserva ciò che il corpo non nomina (`primaria-appello-non-cancella-
 * cio-che-non-nomina`), ma la strada giusta resta la stessa dello 0-6: la rettifica di
 * un'ora passa da `PATCH /api/attendance/daily`, che tocca UNA colonna e basta. La
 * tabella è la stessa (`presenze`) e la chiave `(alunno_id, data)` non sa cosa sia un
 * grado: non serviva una seconda porta, serviva smettere di usare quella sbagliata.
 *
 * Questo file lega la scelta al comportamento: se un domani qualcuno ricablasse il chip
 * sulla POST «per tenere un handler solo», il primo caso qui sotto diventerebbe rosso.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    // L'identità del docente questa pagina la legge dall'URL (`getCurrentTeacherId`):
    // senza, la rettifica esce subito e nessuna richiesta parte.
    useSearchParams: () => new URLSearchParams('userId=docente-0000-4000-8000-000000000001'),
    useParams: () => ({ sectionId: SEZIONE }),
    usePathname: () => `/teacher/primaria/${SEZIONE}/appello`,
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'docente-0000-4000-8000-000000000001', role: 'docente', ready: true }),
}));
vi.mock('@/lib/offline/db', () => ({ saveLocalAppello: vi.fn(async () => undefined), getLocalAppello: vi.fn(async () => []) }));

const SEZIONE = '11111111-1111-4111-8111-111111111111';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const NOTA = 'Ha la febbre da ieri, la mamma ha avvisato';

/** 06:20 e 13:30 UTC = 08:20 e 15:30 italiane, il 7 settembre (ora legale). */
const ENTRATA_ISO = '2026-09-07T06:20:00.000Z';
const USCITA_ISO = '2026-09-07T13:30:00.000Z';

const fetchMock = vi.fn();

const chiamate = (metodo: string, frammento: string) =>
    fetchMock.mock.calls.filter(
        ([u, init]) =>
            String(u).includes(frammento) &&
            ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
    );

const corpoDi = (c: unknown[]) => JSON.parse((c[1] as { body?: string })?.body ?? '{}') as Record<string, unknown>;

beforeEach(() => {
    vi.clearAllMocks();
    // Il bambino è uscito in anticipo: ha ENTRAMBI gli orari, E una nota. È il caso
    // in cui un upsert travestito da rettifica fa danno su tre colonne insieme.
    const riga = {
        presenza_id: 'rec-1',
        id: ALUNNO.id,
        nome: ALUNNO.nome,
        cognome: ALUNNO.cognome,
        stato: 'uscita_anticipata',
        orario_entrata: ENTRATA_ISO,
        orario_uscita: USCITA_ISO,
        note_appello: NOTA,
        giustificata: false,
        giust_vista_il: null,
        giustificazione_testo: null,
    };

    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';
        if (u.includes('/api/primaria/appello') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [riga] }) });
        }
        if (u.includes('/api/attendance/daily') && metodo === 'PATCH') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...riga }) });
        }
        if (u.includes('/api/primaria/classe/')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { alunni: [] } }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import AppelloPrimariaPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/appello/page';

async function apriAppello() {
    render(<AppelloPrimariaPage />);
    await waitFor(() => expect(screen.getByText(new RegExp(ALUNNO.cognome))).toBeInTheDocument());
}

const chip = (campo: 'entrata' | 'uscita') =>
    document.querySelector(`#btn-orario-${campo}-${ALUNNO.id}`) as HTMLButtonElement | null;

async function correggi(campo: 'entrata' | 'uscita', ora: string) {
    await waitFor(() => expect(chip(campo)).not.toBeNull());
    fireEvent.click(chip(campo)!);
    const input = document.querySelector(`#input-orario-${campo}-${ALUNNO.id}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ora } });
    fireEvent.click(document.querySelector(`#btn-salva-orario-${campo}-${ALUNNO.id}`)!);
}

describe('appello primaria — la rettifica di un\'ora passa da una PATCH', () => {
    it('correggendo l\'INGRESSO il corpo nomina una colonna sola: né stato, né uscita, né nota', async () => {
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH', '/api/attendance/daily')).toHaveLength(1));
        const corpo = corpoDi(chiamate('PATCH', '/api/attendance/daily')[0]);
        expect(corpo).toHaveProperty('orario_entrata', '09:10');
        expect(corpo).not.toHaveProperty('orario_uscita');
        expect(corpo).not.toHaveProperty('stato');
        expect(corpo).not.toHaveProperty('noteAppello');
    });

    it('NESSUNA POST parte durante una rettifica: è quella che cancellava la nota', async () => {
        await apriAppello();
        await correggi('uscita', '14:05');

        await waitFor(() => expect(chiamate('PATCH', '/api/attendance/daily')).toHaveLength(1));
        expect(chiamate('POST', '/api/primaria/appello')).toHaveLength(0);
    });

    it('l\'ora sul filo è `HH:MM`, mai un istante', async () => {
        // Il formato canonico lo compone il SERVER, con `aOrarioIso`. Un ISO costruito
        // qui perderebbe il fuso — è la forma naïve che il client scriveva prima.
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH', '/api/attendance/daily')).toHaveLength(1));
        const corpo = corpoDi(chiamate('PATCH', '/api/attendance/daily')[0]);
        expect(String(corpo.orario_entrata)).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    });

    it('chi esce in anticipo mostra ENTRAMBI gli orari: era comunque entrato', async () => {
        await apriAppello();
        await waitFor(() => expect(chip('entrata')).not.toBeNull());
        expect(chip('uscita')).not.toBeNull();
        // Le ore si leggono all'orologio di Roma, non in UTC.
        expect(chip('entrata')!.textContent).toContain('08:20');
        expect(chip('uscita')!.textContent).toContain('15:30');
    });
});
