import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// Le date sono fisse e lontane dall'orologio vero (2000 = già passato, 2999 = ancora da venire): i test non invecchiano.
const sezioni = (stati: { nuova: string; vecchia: string | null; inizioNuova?: string; fineVecchia?: string }) => ([
    { id: SEC_NUOVA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: false, annoId: 'a27', annoEtichetta: '2027/28', annoStato: stati.nuova, annoInizio: stati.inizioNuova ?? '2999-09-01', annoFine: '2999-12-31' },
    ...(stati.vecchia ? [{ id: SEC_VECCHIA, name: NOME, scuolaId: 's', scuolaNome: 'S', school_type: 'infanzia', solaLettura: true, annoId: 'a26', annoEtichetta: '2026/27', annoStato: stati.vecchia, annoInizio: '1999-09-01', annoFine: stati.fineVecchia ?? '2999-08-31' }] : []),
]);
let stati: { nuova: string; vecchia: string | null; inizioNuova?: string; fineVecchia?: string } = { nuova: 'corrente', vecchia: 'in_chiusura' };
/** Se valorizzata, la GET dei bambini della classe VECCHIA resta in volo finché il test non la rilascia. */
let trattieniVecchia: Promise<unknown> | null = null;
/** Idem per la classe NUOVA (scrivibile). */
let trattieniNuova: Promise<unknown> | null = null;

beforeEach(() => {
    vi.clearAllMocks();
    invalidaEducatorSectionsCache();
    bambiniNuova = [];
    stati = { nuova: 'corrente', vecchia: 'in_chiusura' };
    trattieniVecchia = null;
    trattieniNuova = null;
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/educator-sections')) return ok({ sections: sezioni(stati), sectionNames: [NOME] });
        if (u.includes('/api/diary/students')) {
            if (u.includes(SEC_VECCHIA) && trattieniVecchia) return trattieniVecchia.then(() => ok([ALUNNO]));
            if (!u.includes(SEC_VECCHIA) && trattieniNuova) return trattieniNuova.then(() => ok(bambiniNuova));
            return ok(u.includes(SEC_VECCHIA) ? [ALUNNO] : bambiniNuova);
        }
        if (u.includes('/api/attendance/delegates')) return ok([]);
        // Un appello GIÀ registrato (presente, con l'entrata, fatto dalla maestra): è ciò che rende reali «Annulla», l'uscita
        // anticipata e i campi d'orario. Senza, in sola lettura quei comandi non ci sarebbero comunque e il test non li misurerebbe.
        if (u.includes('/api/attendance/daily')) return ok([{ alunno_id: ALUNNO.id, id: 'r1', data: '2999-01-01', stato: 'presente', orario_entrata: '2026-11-13T07:30:00.000Z', orario_uscita: null, registrato_da: 'u-maestra', storico_versione: 1 }]);
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
        // Nessun `button` ATTIVO dentro la riga: né presente/assente, né uscita anticipata, né «Annulla», né «Riprova».
        const righe = document.querySelectorAll('.kv-appello-row');
        expect(righe.length).toBeGreaterThan(0);
        righe.forEach((riga) => {
            expect(within(riga as HTMLElement).queryAllByRole('button')).toHaveLength(0);
            expect(riga.querySelector('input')).toBeNull();
        });
        expect(screen.queryByRole('button', { name: new RegExp(itPresenze.riprova, 'i') })).toBeNull();
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
        // Controllo positivo dei comandi che in sola lettura devono sparire: con l'appello registrato, qui ci sono.
        expect(document.querySelectorAll('.kv-appello-row button').length).toBeGreaterThan(2);
    });
});

describe('appello docente — la classe nuova ancora vuota (L6-2)', () => {
    it('dice che i bambini arrivano con l’inizio dell’anno, non «verifica l’anagrafica»', async () => {
        render(<TeacherAttendancePage />);
        await screen.findByText(new RegExp(itPresenze.nessunAlunnoAnnoNuovo.slice(0, 30)));
        expect(screen.queryByText(new RegExp('Verifica che gli alunni'))).toBeNull();
    });

    it('senza una classe passata (scuola nuova) e con l’anno già iniziato resta il messaggio sull’anagrafica', async () => {
        stati = { nuova: 'corrente', vecchia: null, inizioNuova: '2000-09-01' };
        render(<TeacherAttendancePage />);
        await screen.findByText(new RegExp('Verifica che gli alunni'));
        expect(screen.queryByText(new RegExp(itPresenze.nessunAlunnoAnnoNuovo.slice(0, 30)))).toBeNull();
    });
});

describe('appello docente — frase «arrivano con l’inizio dell’anno» dipende dalla DATA (rilievo 3)', () => {
    it('anno nuovo già iniziato e classe vuota: la frase è quella sull’anagrafica (il problema è vero)', async () => {
        stati = { nuova: 'corrente', vecchia: 'in_chiusura', inizioNuova: '2000-09-01' };
        render(<TeacherAttendancePage />);
        await screen.findByText(new RegExp('Verifica che gli alunni'));
        expect(screen.queryByText(new RegExp(itPresenze.nessunAlunnoAnnoNuovo.slice(0, 30)))).toBeNull();
    });
});

describe('appello docente — il cambio di classe svuota lo stato (rilievo 5)', () => {
    it('🔴 passando da una classe passata a una scrivibile, per la durata della lettura NON restano i bambini di prima con i pulsanti attivi', async () => {
        bambiniNuova = [ALUNNO];
        render(<TeacherAttendancePage />);
        const sel = await screen.findByLabelText(itPresenze.sezioneSelettore);
        fireEvent.change(sel, { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(document.querySelector(`#btn-presente-${ALUNNO.id}`)).toBeNull();

        let rilascia: () => void = () => {};
        trattieniNuova = new Promise<void>((ok) => { rilascia = ok; });
        fireEvent.change(sel, { target: { value: SEC_NUOVA } });

        // La lettura della classe nuova è in volo: la riga della classe di prima non deve comparire con i pulsanti della nuova.
        await new Promise((r) => setTimeout(r, 50));
        expect(document.querySelector(`#btn-presente-${ALUNNO.id}`)).toBeNull();
        expect(screen.queryByText('Mario Rossi')).toBeNull();
        rilascia();
        await waitFor(() => expect(document.querySelector(`#btn-presente-${ALUNNO.id}`)).not.toBeNull());
    });
});

describe('appello docente — il giorno di partenza in sola lettura (rilievo 9)', () => {
    const giornoSelezionato = () => (document.querySelector('input[type="date"]') as HTMLInputElement);

    it('classe di un anno GIÀ FINITO: si parte dall’ultimo giorno dell’anno, non da oggi', async () => {
        stati = { nuova: 'corrente', vecchia: 'chiuso', fineVecchia: '2000-08-31' };
        render(<TeacherAttendancePage />);
        fireEvent.change(await screen.findByLabelText(itPresenze.sezioneSelettore), { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(giornoSelezionato().value).toBe('2000-08-31');
        expect(giornoSelezionato().max).toBe('2000-08-31');
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/attendance/daily') && String(u).includes('data=2000-08-31'))).toBe(true));
    });

    it('classe di un anno NON ancora finito (in chiusura): si parte da oggi', async () => {
        render(<TeacherAttendancePage />);
        fireEvent.change(await screen.findByLabelText(itPresenze.sezioneSelettore), { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(giornoSelezionato().value).toBe(new Date().toLocaleDateString('en-CA'));
    });

    it('il selettore di giorno in sola lettura ha area di tocco da 44 px, un nome accessibile e niente «Oggi»', async () => {
        stati = { nuova: 'corrente', vecchia: 'chiuso', fineVecchia: '2000-08-31' };
        render(<TeacherAttendancePage />);
        fireEvent.change(await screen.findByLabelText(itPresenze.sezioneSelettore), { target: { value: SEC_VECCHIA } });
        await screen.findByText('Mario Rossi');
        expect(screen.getByLabelText(itPresenze.giornoDaVedere)).toBe(giornoSelezionato());
        for (const nome of [itPresenze.giornoPrecedente, itPresenze.giornoSuccessivo]) {
            const b = screen.getByRole('button', { name: nome });
            expect(b.className).toMatch(/\bh-11\b/);
            expect(b.className).toMatch(/\bw-11\b/);
        }
        expect(giornoSelezionato().parentElement?.className).toMatch(/min-h-11/);
        // L'unico «Oggi» è la linguetta della pagina: il pulsante «torna a oggi» del navigatore non c'è in una classe passata.
        expect(screen.getAllByRole('button', { name: itPresenze.oggi })).toHaveLength(1);
        // Il giorno dopo l'ultimo dell'anno non si apre.
        expect(screen.getByRole('button', { name: itPresenze.giornoSuccessivo })).toBeDisabled();
    });

    it('sulla classe scrivibile il selettore resta quello di sempre (nessun 44 px, «Oggi» disponibile dopo un passo indietro)', async () => {
        bambiniNuova = [ALUNNO];
        render(<TeacherAttendancePage />);
        await screen.findByText('Mario Rossi');
        const prec = screen.getByRole('button', { name: itPresenze.giornoPrecedente });
        expect(prec.className).toMatch(/\bh-8\b/);
    });
});

