import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

import itDiario from '../../messages/it/diario.json';

/**
 * CHI RIAPRE L'APP TROVA IL DIARIO DI ADESSO, NON QUELLO DI QUANDO L'AVEVA APERTO.
 *
 * ─── IL DIFETTO, MISURATO IL 2026-09-28 ────────────────────────────────────
 * «La maestra dice che compila il diario, i genitori dicono che è vuoto.» Avevano ragione
 * tutti e due. Le voci della Sez. Abbracci erano in archivio per 169 giornate-presenza su
 * 170; ma la pagina del genitore caricava le voci UNA volta, all'apertura, e non si
 * ricaricava mai più. Chi la apriva al mattino — prima che ci fosse qualcosa: alle 13:00 in
 * quella sezione aveva una voce visibile solo il 50% dei bambini — e riapriva l'app nel
 * pomeriggio leggeva ancora «La maestra non ha ancora compilato il diario per questo
 * giorno», con le voci già scritte.
 *
 * Il ritorno si simula con `visibilitychange`, che è il segnale che arriva anche su web.
 */

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/parent/diary',
}));
vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p1', studentId: 'a1', ready: true, figliIds: ['a1'] }),
}));
vi.mock('@/lib/auth/use-child-school-type', () => ({
    useChildSchoolType: () => ({ schoolType: 'nido', ready: true }),
}));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));

/** Le risposte del diario, in ordine: ogni chiamata consuma la prossima. */
const h = vi.hoisted(() => ({
    risposte: [] as Array<() => Promise<{ data: unknown; offline: boolean }>>,
    chiavi: [] as string[],
    checkin: [] as Array<() => Promise<unknown>>,
}));

// `fetchConCache(chiave, url)`: il PRIMO argomento è la chiave (`diario:<alunno>:<data>:<data>`).
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: vi.fn(async (chiave: string) => {
        h.chiavi.push(chiave);
        const prossima = h.risposte.shift();
        if (!prossima) throw new Error('nessuna risposta preparata per ' + chiave);
        return prossima();
    }),
}));

import { fetchConCache } from '@/lib/offline/read-cache';
import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page';

const oggi = (ora: number) => { const d = new Date(); d.setHours(ora, 0, 0, 0); return d.toISOString(); };

const PRANZO = { id: 'e-pranzo', tipo_evento: 'pranzo', timestamp_evento: oggi(12),
    dettagli: { corsi: { primo: 'niente' } }, note: null, notaBambino: null };
const MERENDA_DI_IERI = { id: 'e-merenda', tipo_evento: 'merenda', timestamp_evento: oggi(10),
    dettagli: { corsi: { merenda: 'meta' } }, note: null, notaBambino: null };

const ok = (data: unknown) => () => Promise.resolve({ data, offline: false });
const rete = () => () => Promise.reject(new TypeError('Failed to fetch'));

function risposta(corpo: unknown) {
    return { ok: true, status: 200, json: async () => corpo };
}

beforeEach(() => {
    vi.clearAllMocks();
    h.risposte = [];
    h.chiavi = [];
    h.checkin = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/diary/checkin')) {
            const prossima = h.checkin.shift();
            return prossima ? prossima() : risposta({ stato: null, orario_entrata: null });
        }
        if (String(url).startsWith('/api/diary/students')) return risposta({ nome: 'Ada', cognome: 'B' });
        return risposta({ media: [], total: 0 });
    }));
});

/** Il telefono va in tasca e torna in mano: prima nascosta, poi di nuovo visibile. */
function tornaNellApp() {
    act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

/** Lascia finire la ricarica: la catena diario → entrata → foto è sequenziale. */
async function lasciaFinire() {
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
}

describe('diario del genitore — si ricarica quando si torna nell\'app', () => {
    it('chi torna nell\'app trova le voci scritte nel frattempo, non «Nessuna voce»', async () => {
        h.risposte.push(ok([]), ok([PRANZO]));
        render(<ParentDiaryPage />);
        // Ancora positiva: la pagina ha davvero finito il primo caricamento, e a vuoto.
        await screen.findByText(itDiario.vuotoTitolo);

        tornaNellApp();

        expect(await screen.findByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
        expect(screen.queryByText(itDiario.vuotoTitolo)).not.toBeInTheDocument();
    });

    it('se al ritorno la rete non risponde, restano le voci già mostrate: mai «Nessuna voce» al loro posto', async () => {
        // Subito dopo la riapertura la rete del telefono spesso non c'è ancora: in `app_log` sono
        // centinaia di «Failed to fetch» / «Load failed» a stato 0. Una ricarica che in quel caso
        // svuotasse la pagina trasformerebbe la correzione nel difetto che corregge.
        h.risposte.push(ok([PRANZO]), rete());
        h.checkin.push(
            () => Promise.resolve(risposta({ stato: 'presente', orario_entrata: null })),
            () => Promise.reject(new TypeError('Failed to fetch')),
        );
        render(<ParentDiaryPage />);
        await screen.findByText(new RegExp(itDiario.quantita_niente));
        expect(screen.getByText(itDiario.entrataLabel)).toBeInTheDocument();

        tornaNellApp();
        await waitFor(() => expect(fetchConCache).toHaveBeenCalledTimes(2));
        await lasciaFinire();

        expect(screen.getByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
        expect(screen.getByText(itDiario.entrataLabel), 'l\'entrata è sparita per una ricarica fallita').toBeInTheDocument();
        expect(screen.queryByText(itDiario.vuotoTitolo)).not.toBeInTheDocument();
    });

    it('una ricarica lenta non scrive le voci di oggi sopra il giorno scelto nel frattempo', async () => {
        let rispondiOggi: (v: { data: unknown; offline: boolean }) => void = () => {};
        h.risposte.push(
            ok([]),                                                       // apertura: oggi, vuoto
            () => new Promise((r) => { rispondiOggi = r; }),              // ritorno: oggi, lenta
            ok([MERENDA_DI_IERI]),                                        // tocco su «ieri»
        );
        render(<ParentDiaryPage />);
        await screen.findByText(itDiario.vuotoTitolo);

        tornaNellApp();
        await waitFor(() => expect(fetchConCache).toHaveBeenCalledTimes(2));

        fireEvent.click(screen.getByLabelText(itDiario.giornoPrecedente));
        await screen.findByText(new RegExp(itDiario.quantita_meta));
        expect(h.chiavi[2], 'il terzo caricamento non era il giorno prima').not.toBe(h.chiavi[1]);

        await act(async () => { rispondiOggi({ data: [PRANZO], offline: false }); });
        await lasciaFinire();

        expect(screen.getByText(new RegExp(itDiario.quantita_meta))).toBeInTheDocument();
        expect(
            screen.queryByText(new RegExp(itDiario.quantita_niente)),
            'le voci di oggi sono finite sotto il giorno di ieri',
        ).not.toBeInTheDocument();
    });
});
