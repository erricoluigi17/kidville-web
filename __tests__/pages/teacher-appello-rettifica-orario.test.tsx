import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';


/**
 * Appello 0-6 — correggere un'ora non deve cancellarne un'altra.
 *
 * ─── IL RISCHIO, ed è tutto qui ───────────────────────────────────────────────
 *
 * La strada corta per «cambia l'orario» sarebbe stata riusare `handleSetStato`,
 * che è l'unico handler di scrittura che questa pagina aveva. Non si può: quella
 * fa una POST, la POST è un **upsert della riga intera**, e l'handler calcola
 *
 *     orario_uscita = stato === 'uscita_anticipata' ? … : null
 *
 * cioè AZZERA l'orario che non sta cambiando. Ripassare di lì per rettificare
 * l'ingresso di un bambino uscito in anticipo gli cancellerebbe l'ora d'uscita —
 * in silenzio, e su un registro.
 *
 * Questo file lega la scelta al comportamento: la rettifica passa da una PATCH,
 * il corpo nomina UNA colonna sola, e nessuna POST parte. Se un domani qualcuno
 * ricablasse il chip su `handleSetStato` per «tenere un handler solo», il primo
 * caso qui sotto diventerebbe rosso col corpo sbagliato in faccia.
 *
 * ⚠️ La prova che serviva davvero: `handleConfirmCheckout` (il modale del
 * checkout delegato) chiama `handleSetStato('uscita_anticipata')` su un bambino
 * che può già avere l'ora d'uscita rettificata. Anche lì `now` è diventato
 * `?? now` — l'ultimo caso di questo file.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/teacher/attendance',
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'docente-0000-4000-8000-000000000001', role: 'docente', ready: true }),
}));
vi.mock('@/components/features/teacher/attendance/MonthlyAttendanceTable', () => ({
    MonthlyAttendanceTable: () => null,
}));
vi.mock('@/lib/offline/db', () => ({}));

const SEZIONE = 'TEST Infanzia';
const ALUNNO = { id: 'aaaa1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const NOME_COMPLETO = `${ALUNNO.nome} ${ALUNNO.cognome}`;

/** 08:00 e 11:00 UTC = 10:00 e 13:00 italiane, il 7 settembre (ora legale). */
const ENTRATA_ISO = '2026-09-07T08:00:00.000Z';
const USCITA_ISO = '2026-09-07T11:00:00.000Z';

interface RigaPresenza {
    id: string;
    alunno_id: string;
    data: string;
    stato: string;
    orario_entrata: string | null;
    orario_uscita: string | null;
}

let salvate: RigaPresenza[];
let patchRiesce: boolean;
const fetchMock = vi.fn();

const chiamate = (metodo: string) =>
    fetchMock.mock.calls.filter(
        ([u, init]) =>
            String(u).includes('/api/attendance/daily') &&
            ((init as { method?: string } | undefined)?.method ?? 'GET') === metodo,
    );

beforeEach(() => {
    vi.clearAllMocks();
    patchRiesce = true;
    // Il bambino è uscito in anticipo: ha ENTRAMBI gli orari. È il caso in cui un
    // upsert travestito da patch farebbe danno.
    salvate = [{
        id: 'rec-1',
        alunno_id: ALUNNO.id,
        data: new Date().toISOString().slice(0, 10),
        stato: 'uscita_anticipata',
        orario_entrata: ENTRATA_ISO,
        orario_uscita: USCITA_ISO,
    }];

    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        const metodo = init?.method ?? 'GET';

        if (u.includes('/api/educator-sections')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ sectionNames: [SEZIONE] }) });
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        }
        if (u.includes('/api/attendance/delegates')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [] });
        }
        if (u.includes('/api/attendance/daily') && metodo === 'GET') {
            return Promise.resolve({ ok: true, status: 200, json: async () => salvate });
        }
        if (u.includes('/api/attendance/daily') && metodo === 'PATCH') {
            if (!patchRiesce) {
                return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'Servizio non disponibile' }) });
            }
            // Il finto server fa quello che fa quello vero: tocca la SOLA colonna
            // nominata. Se la pagina mandasse un corpo da upsert, la riga qui sotto
            // conserverebbe comunque l'altro orario e il test non vedrebbe niente:
            // per questo l'asserzione è sul CORPO, non sull'esito.
            const inviato = JSON.parse(init?.body ?? '{}') as Record<string, string>;
            const r = salvate[0];
            if ('orario_entrata' in inviato) r.orario_entrata = `2026-09-07T${inviato.orario_entrata}:00+02:00`;
            if ('orario_uscita' in inviato) r.orario_uscita = `2026-09-07T${inviato.orario_uscita}:00+02:00`;
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...r }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherAttendancePage from '@/app/(dashboard)/teacher/attendance/page';

async function apriAppello() {
    render(<TeacherAttendancePage />);
    await waitFor(() => expect(screen.getByText(NOME_COMPLETO)).toBeInTheDocument());
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

describe('la rettifica passa da una PATCH, e nomina una colonna sola', () => {
    it('correggendo l\'INGRESSO, il corpo non contiene né lo stato né l\'uscita', async () => {
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1));
        const corpo = JSON.parse((chiamate('PATCH')[0][1] as { body: string }).body);
        expect(corpo).toEqual({ alunno_id: ALUNNO.id, data: expect.any(String), orario_entrata: '09:10' });
        expect('orario_uscita' in corpo).toBe(false);
        expect('stato' in corpo).toBe(false);
    });

    it('correggendo l\'USCITA, il corpo non contiene l\'ingresso', async () => {
        await apriAppello();
        await correggi('uscita', '15:30');

        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1));
        const corpo = JSON.parse((chiamate('PATCH')[0][1] as { body: string }).body);
        expect(corpo.orario_uscita).toBe('15:30');
        expect('orario_entrata' in corpo).toBe(false);
    });

    it('durante la rettifica NON parte nessuna POST: sarebbe un upsert della riga intera', async () => {
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1));
        expect(chiamate('POST')).toHaveLength(0);
    });

    it('l\'ora sul filo è HH:MM, mai un istante: un ISO uscirebbe in chiaro nei log', async () => {
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1));
        const corpo = (chiamate('PATCH')[0][1] as { body: string }).body;
        expect(corpo).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
});

describe('quando la rettifica non riesce', () => {
    it('la maestra lo vede subito, e l\'avviso nomina il bambino', async () => {
        patchRiesce = false;
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(screen.queryByRole('alert')).toBeInTheDocument());
        expect(within(screen.getByRole('alert')).getByText(NOME_COMPLETO)).toBeInTheDocument();
    });

    it('e l\'ora torna quella di prima: un rollback muto farebbe credere che sia andata', async () => {
        patchRiesce = false;
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(screen.queryByRole('alert')).toBeInTheDocument());
        expect(chip('entrata')!.textContent).toContain('10:00');
    });

    it('quando riesce, invece, nessun avviso', async () => {
        await apriAppello();
        await correggi('entrata', '09:10');

        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1));
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
