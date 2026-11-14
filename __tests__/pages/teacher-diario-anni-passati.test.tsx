import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invalidaEducatorSectionsCache } from '@/lib/sezioni/educator-sections-cache';
import itDiario from '../../messages/it/teacherDiario.json';

/**
 * Lotto 8 — il diario del docente apre in SOLA LETTURA le classi degli anni passati.
 *
 * Il finto server risponde come `/api/educator-sections?passati=1`: la classe dell'anno in corso (scrivibile) e quella del
 * 2025/26 `chiuso` (sola lettura) con lo STESSO nome. Sulla classe passata: selettore con l'anno, scritta, data limitata
 * all'anno, nessun controllo di scrittura (filtro presenti, editor), e le letture vanno sulle route `dellAnno=1`.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/teacher/diary',
}));
vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => 'docente-0000-4000-8000-000000000001' }));
vi.mock('@/lib/offline/db', () => ({}));

const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1';
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2';
const NOME = 'TEST Infanzia';
const ALUNNO = { id: 'bbbb1111-0000-4000-8000-000000000001', nome: 'Mario', cognome: 'Rossi' };
const fetchMock = vi.fn();

const sezioni = () => ([
    { id: SEC_NUOVA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2026/27', annoStato: 'corrente', annoInizio: '2026-09-01', annoFine: '2999-08-31' },
    { id: SEC_VECCHIA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: true, annoId: 'a26', annoEtichetta: '2025/26', annoStato: 'chiuso', annoInizio: '1999-09-01', annoFine: '2000-08-31' },
]);

beforeEach(() => {
    vi.clearAllMocks();
    invalidaEducatorSectionsCache();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/educator-sections')) return ok({ sections: sezioni(), sectionNames: [NOME] });
        if (u.includes('/api/diary/config')) return ok({ diario_primaria_visibile: true, routine_attive: ['pasto'] });
        if (u.includes('/api/diary/students')) return ok(u.includes(SEC_VECCHIA) ? [ALUNNO] : []);
        if (u.includes('/api/diary/entries')) return ok(u.includes(SEC_VECCHIA) ? [{ id: 'e1', alunno_id: ALUNNO.id, tipo_evento: 'pranzo', orario_inizio: '2000-03-10T11:30:00+01:00' }] : []);
        return ok({});
    });
    vi.stubGlobal('fetch', fetchMock);
});

import TeacherDiaryPage from '@/app/(dashboard)/teacher/diary/page';

const apriVecchia = async () => {
    render(<TeacherDiaryPage />);
    const pill = await screen.findByRole('button', { name: `${NOME} · 2025/26` });
    fireEvent.click(pill);
};

describe('diario docente — classi degli anni passati (lotto 8)', () => {
    it('chiede alla route anche le classi passate, e il selettore porta l’anno accanto al nome', async () => {
        render(<TeacherDiaryPage />);
        await screen.findByRole('button', { name: `${NOME} · 2026/27` });
        expect(screen.getByRole('button', { name: `${NOME} · 2025/26` })).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/educator-sections') && String(u).includes('passati=1'))).toBe(true);
    });

    it('🔴 classe passata: scritta «Anno passato», voci del giorno in sola lettura, NESSUN controllo di scrittura', async () => {
        await apriVecchia();
        await screen.findByText('Mario Rossi');
        expect(screen.getByText('Pranzo')).toBeInTheDocument();
        expect(document.querySelector('[data-sola-lettura]')).not.toBeNull();
        expect(screen.getByText(/Anno passato/)).toBeInTheDocument();
        // Né il filtro presenti/tutti, né l'editor degli eventi: dentro la vista c'è solo la scelta del giorno.
        expect(screen.queryByTitle(itDiario.titlePresenti)).toBeNull();
        expect(screen.queryByTitle(itDiario.titleTutti)).toBeNull();
        expect(screen.queryByText(itDiario.registra)).toBeNull();
        const bottoniDentro = document.querySelectorAll('[data-diario-sola-lettura] button');
        expect(bottoniDentro.length).toBe(0);
    });

    it('la data è limitata all’anno della classe e l’area di tocco è da 44 px', async () => {
        await apriVecchia();
        const data = (await screen.findByLabelText(itDiario.slGiorno)) as HTMLInputElement;
        expect(data.min).toBe('1999-09-01');
        expect(data.max).toBe('2000-08-31');
        // Oltre la fine dell'anno il giorno di partenza è l'ultimo giorno dell'anno, non oggi.
        expect(data.value).toBe('2000-08-31');
        expect(data.className).toContain('min-h-11');
    });

    it('le letture vanno su `dellAnno=1` e nessuna scrittura parte mai', async () => {
        await apriVecchia();
        await screen.findByText('Mario Rossi');
        const chiamate = fetchMock.mock.calls.map(([u, init]) => ({ u: String(u), metodo: (init as { method?: string } | undefined)?.method ?? 'GET' }));
        expect(chiamate.some((c) => c.u.includes('/api/diary/students') && c.u.includes('dellAnno=1') && c.u.includes(SEC_VECCHIA))).toBe(true);
        expect(chiamate.some((c) => c.u.includes('/api/diary/entries') && c.u.includes('dellAnno=1') && c.u.includes(SEC_VECCHIA))).toBe(true);
        expect(chiamate.filter((c) => c.metodo !== 'GET')).toEqual([]);
        // Il diario di OGGI per la classe passata non si carica (l'editor non nasce).
        expect(chiamate.some((c) => c.u.includes('/api/diary/entries') && !c.u.includes('dellAnno=1') && c.u.includes(SEC_VECCHIA))).toBe(false);
    });

    it('la classe dell’anno in corso resta con l’editor: niente scritta di sola lettura', async () => {
        render(<TeacherDiaryPage />);
        await screen.findByRole('button', { name: `${NOME} · 2026/27` });
        await waitFor(() => expect(screen.queryByText(itDiario.inCaricamento)).toBeNull());
        expect(document.querySelector('[data-sola-lettura]')).toBeNull();
        expect(document.querySelector('[data-diario-sola-lettura]')).toBeNull();
    });
});
