import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * Appello nel cockpit — quello che la segreteria non aveva.
 *
 * Per la PRIMARIA la schermata esisteva già ma era sepolta in tre clic; per NIDO e
 * INFANZIA non esisteva affatto. Questo file lega al comportamento le quattro scelte
 * che ci sono volute, e ognuna ha una ragione che senza test si perde:
 *
 *  1. le classi vengono da `sections/scoped`, MAI da `educator-sections`: quest'ultima
 *     non conosce `segreteria` e le risponderebbe `200 []` — un elenco vuoto e nessun
 *     errore, cioè il modo peggiore di rompersi;
 *  2. la classe viaggia al server come UUID, mai come nome: fra tre sedi «2 ANNI» non
 *     identifica niente, e una route che indovina archivia nel plesso sbagliato in
 *     silenzio;
 *  3. una classe di primaria porta al registro della sua classe e NON monta il motore
 *     0-6, che di quel grado non sa niente;
 *  4. il MOTIVO della giustifica (dato sanitario, art. 9 GDPR) non compare: il server
 *     non lo manda nemmeno a chi vede tutte le classi. È «vero per costruzione», ed è
 *     esattamente il genere di verità che si rompe in silenzio quando qualcuno cambia
 *     una `select`.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams('userId=segr-0000-4000-8000-000000000001'),
    useParams: () => ({}),
    usePathname: () => '/admin/appello',
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: 'segr-0000-4000-8000-000000000001', role: 'segreteria', ready: true }),
}));
vi.mock('@/components/features/teacher/attendance/MonthlyAttendanceTable', () => ({
    MonthlyAttendanceTable: () => <div data-testid="tabella-mese" />,
}));
vi.mock('@/lib/offline/db', () => ({}));

const NIDO = { id: 'aaaa1111-0000-4000-8000-00000000000a', name: '2 ANNI', school_type: 'nido' };
const PRIMARIA = { id: 'bbbb2222-0000-4000-8000-00000000000b', name: '3ª A', school_type: 'primaria' };
const ALUNNO = { id: 'cccc3333-0000-4000-8000-00000000000c', nome: 'Mario', cognome: 'Rossi' };
const MOTIVO = 'Ricovero in ospedale per accertamenti';

const fetchMock = vi.fn();
const urlChiamate = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/admin/sections/scoped')) {
            return Promise.resolve({
                ok: true, status: 200, json: async () => ({
                    success: true,
                    data: [{ scuolaId: 'sc-1', scuolaNome: 'Kidville Giugliano', sezioni: [NIDO, PRIMARIA] }],
                }),
            });
        }
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        }
        if (u.includes('/api/attendance/daily')) {
            // Ciò che il server manda DAVVERO a chi vede tutte le classi: niente
            // `giustificazione_testo`, perché `colonneConMotivo` non lo chiede.
            return Promise.resolve({
                ok: true, status: 200, json: async () => [{
                    id: 'rec-1', alunno_id: ALUNNO.id, data: '2026-09-07',
                    stato: 'assente', orario_entrata: null, orario_uscita: null, giustificata: true,
                }],
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import AdminAppelloPage from '@/app/(dashboard)/admin/appello/page';

async function apri() {
    render(<AdminAppelloPage />);
    await waitFor(() => expect(urlChiamate().some(u => u.includes('sections/scoped'))).toBe(true));
}

describe('/admin/appello — la segreteria vede e corregge', () => {
    it('le classi vengono da `sections/scoped`, e MAI da `educator-sections`', async () => {
        await apri();
        // `educator-sections` non conosce `segreteria`: risponderebbe con un elenco
        // vuoto e nessun errore, e la schermata direbbe «nessuna classe».
        expect(urlChiamate().some(u => u.includes('/api/educator-sections'))).toBe(false);
        expect(urlChiamate().some(u => u.includes('grado=nido,infanzia,primaria'))).toBe(true);
    });

    it('la classe viaggia come UUID, mai come nome', async () => {
        await apri();
        await waitFor(() => expect(urlChiamate().some(u => u.includes('/api/attendance/daily'))).toBe(true));
        const chiamata = urlChiamate().find(u => u.includes('/api/attendance/daily'))!;
        expect(chiamata).toContain(`sectionId=${NIDO.id}`);
        // Fra tre sedi «2 ANNI» non identifica una classe.
        expect(chiamata).not.toContain('sezione=2');
    });

    it('scegliendo una classe di PRIMARIA porta al registro, e non monta il motore 0-6', async () => {
        await apri();
        await waitFor(() => expect(screen.getByText(ALUNNO.cognome, { exact: false })).toBeInTheDocument());

        const select = document.querySelectorAll('select')[0] as HTMLSelectElement;
        fireEvent.change(select, { target: { value: PRIMARIA.id } });

        await waitFor(() => {
            const link = document.querySelector(`a[href*="/admin/primaria/${PRIMARIA.id}/appello"]`);
            expect(link).not.toBeNull();
        });
        expect(screen.queryByText(ALUNNO.cognome, { exact: false })).toBeNull();
    });

    it('il MOTIVO sanitario della giustifica non compare: il server non lo manda nemmeno', async () => {
        await apri();
        await waitFor(() => expect(screen.getByText(ALUNNO.cognome, { exact: false })).toBeInTheDocument());
        expect(document.body.textContent).not.toContain(MOTIVO);
        expect(document.body.textContent).not.toContain('ospedale');
    });

    it('se l\'elenco delle classi non si carica, lo dice ai log invece di tacere', async () => {
        // «Nessuna classe» e «non ho potuto leggere l'elenco» sono due cose diverse con
        // rimedi opposti, e a schermo si vedono identiche.
        fetchMock.mockImplementation((url: string) =>
            String(url).includes('/api/admin/sections/scoped')
                ? Promise.reject(new Error('rete giù'))
                : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) }),
        );
        render(<AdminAppelloPage />);
        await waitFor(() => expect(h.logClient).toHaveBeenCalled());
        const msg = String((h.logClient.mock.calls[0][0] as { messaggio: string }).messaggio);
        expect(msg).toContain('appello-classi-non-caricate');
    });
});
