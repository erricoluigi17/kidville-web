import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invalidaEducatorSectionsCache } from '@/lib/sezioni/educator-sections-cache';
import itPresenze from '../../messages/it/teacherPresenze.json';

/**
 * Lotto 6 · L6-1 e L6-2 — l'appello del docente apre in SOLA LETTURA le classi degli anni passati, e nella classe nuova ancora
 * vuota non manda a «verificare l'anagrafica».
 *
 * Il finto server risponde come `/api/educator-sections?passati=1`: la classe dell'anno in corso (scrivibile) e quella del
 * 2026/27 `in_chiusura` (sola lettura) con lo STESSO nome. Il selettore deve distinguerle dall'anno, e sulla classe di sola
 * lettura non deve esserci nessun pulsante di scrittura.
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

const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1';
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2';
const NOME = 'TEST Infanzia';
const ALUNNO = { id: 'bbbb1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };

let bambiniNuova: unknown[];
const fetchMock = vi.fn();

const sezioni = (stati: { nuova: string; vecchia: string | null }) => ([
    { id: SEC_NUOVA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2027/28', annoStato: stati.nuova },
    ...(stati.vecchia ? [{ id: SEC_VECCHIA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: true, annoId: 'a26', annoEtichetta: '2026/27', annoStato: stati.vecchia }] : []),
]);
let stati = { nuova: 'corrente', vecchia: 'in_chiusura' as string | null };

beforeEach(() => {
    vi.clearAllMocks();
    invalidaEducatorSectionsCache();
    bambiniNuova = [];
    stati = { nuova: 'corrente', vecchia: 'in_chiusura' };
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/educator-sections')) return ok({ sections: sezioni(stati), sectionNames: [NOME] });
        if (u.includes('/api/diary/students')) return ok(u.includes(SEC_VECCHIA) ? [ALUNNO] : bambiniNuova);
        if (u.includes('/api/attendance/delegates')) return ok([]);
        if (u.includes('/api/attendance/daily')) return ok([]);
        return ok({});
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherAttendancePage from '@/app/(dashboard)/teacher/attendance/page';

describe('appello docente — classi degli anni passati (L6-1)', () => {
    it('chiede alla route anche le classi passate', async () => {
        render(<TeacherAttendancePage />);
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/educator-sections') && String(u).includes('passati=1'))).toBe(true));
    });

    it('con più di una classe compare il selettore, con l’anno accanto al nome', async () => {
        render(<TeacherAttendancePage />);
        const sel = (await screen.findByLabelText(itPresenze.sezioneSelettore)) as HTMLSelectElement;
        expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([`${NOME} · 2027/28`, `${NOME} · 2026/27`]);
        expect(document.querySelector('[data-sola-lettura]')).toBeNull();
    });

    it('scelta la classe `in_chiusura`: scritta «Anno che si sta chiudendo» e nessun pulsante di scrittura', async () => {
        render(<TeacherAttendancePage />);
        const sel = await screen.findByLabelText(itPresenze.sezioneSelettore);
        fireEvent.change(sel, { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(screen.getByText(new RegExp(itPresenze.annoInChiusura))).toBeInTheDocument();
        expect(document.querySelector(`#btn-presente-${ALUNNO.id}`)).toBeNull();
        expect(document.querySelector(`#btn-assente-${ALUNNO.id}`)).toBeNull();
    });

    it('un anno `chiuso` dice «Anno passato»', async () => {
        stati = { nuova: 'corrente', vecchia: 'chiuso' };
        render(<TeacherAttendancePage />);
        fireEvent.change(await screen.findByLabelText(itPresenze.sezioneSelettore), { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(screen.getByText(new RegExp(itPresenze.annoPassato))).toBeInTheDocument();
    });

    it('la classe dell’anno in corso resta scrivibile', async () => {
        bambiniNuova = [ALUNNO];
        render(<TeacherAttendancePage />);
        await screen.findByText('Mario Rossi');
        await waitFor(() => expect(document.querySelector(`#btn-presente-${ALUNNO.id}`)).not.toBeNull());
    });
});

describe('appello docente — la classe nuova ancora vuota (L6-2)', () => {
    it('dice che i bambini arrivano con l’inizio dell’anno, non «verifica l’anagrafica»', async () => {
        render(<TeacherAttendancePage />);
        await screen.findByText(new RegExp(itPresenze.nessunAlunnoAnnoNuovo.slice(0, 30)));
        expect(screen.queryByText(new RegExp('Verifica che gli alunni'))).toBeNull();
    });

    it('senza una classe passata (scuola nuova) resta il messaggio sull’anagrafica', async () => {
        stati = { nuova: 'corrente', vecchia: null };
        render(<TeacherAttendancePage />);
        await screen.findByText(new RegExp('Verifica che gli alunni'));
        expect(screen.queryByText(new RegExp(itPresenze.nessunAlunnoAnnoNuovo.slice(0, 30)))).toBeNull();
    });
});
