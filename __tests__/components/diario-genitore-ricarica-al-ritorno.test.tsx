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
import { segnalaNotificaAperta } from '@/lib/notifiche/pagina-aperta-da-notifica';
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

    it('un ritorno mentre il giorno scelto sta ancora arrivando non lo scavalca: a schermo va quel giorno', async () => {
        // Rilievo del critico, 2026-09-28, riprodotto prima della correzione: il genitore tocca
        // «ieri», il telefono va in tasca e torna in mano con la rete ancora giù. La ricarica
        // prendeva il posto del caricamento in volo, falliva e «teneva lo schermo» — che però
        // mostrava ancora OGGI: sotto l'etichetta «ieri» restava il pranzo di oggi.
        let rispondiIeri: (v: { data: unknown; offline: boolean }) => void = () => {};
        h.risposte.push(
            ok([PRANZO]),                                              // apertura: oggi
            () => new Promise((r) => { rispondiIeri = r; }),           // tocco su «ieri»: lento
            rete(),                                                    // se il ritorno rileggesse
        );
        render(<ParentDiaryPage />);
        await screen.findByText(new RegExp(itDiario.quantita_niente));

        fireEvent.click(screen.getByLabelText(itDiario.giornoPrecedente));
        await waitFor(() => expect(fetchConCache).toHaveBeenCalledTimes(2));
        tornaNellApp();
        await act(async () => { rispondiIeri({ data: [MERENDA_DI_IERI], offline: false }); });
        await lasciaFinire();

        expect(await screen.findByText(new RegExp(itDiario.quantita_meta))).toBeInTheDocument();
        expect(
            screen.queryByText(new RegExp(itDiario.quantita_niente)),
            'sotto «ieri» è rimasto il pranzo di oggi',
        ).not.toBeInTheDocument();
        // Il giorno era già in arrivo: il ritorno lo aspetta invece di chiederlo una seconda volta.
        expect(fetchConCache).toHaveBeenCalledTimes(2);
    });

    it('se il diario non si legge (rete giù e nessuna copia salvata) lo dice, invece di accusare la maestra', async () => {
        // Fino al 2026-09-28 una lettura fallita mostrava «Nessuna voce — La maestra non ha ancora
        // compilato il diario per questo giorno»: una frase falsa, e proprio quella che i genitori
        // riferivano alla scuola.
        h.risposte.push(rete(), ok([PRANZO]));
        render(<ParentDiaryPage />);

        expect(await screen.findByText(itDiario.erroreTitolo)).toBeInTheDocument();
        expect(screen.queryByText(itDiario.vuotoTitolo)).not.toBeInTheDocument();
        expect(screen.queryByText(itDiario.vuotoTesto)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: itDiario.riprova }));

        expect(await screen.findByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
        expect(screen.queryByText(itDiario.erroreTitolo)).not.toBeInTheDocument();
    });

    it('al ritorno, se risponde solo la copia salvata, si riprova da solo qualche secondo dopo', async () => {
        // Il caso vero della rete che non c'è ancora: `fetchConCache` NON lancia, restituisce la
        // copia salvata con `offline: true` — la stessa, vuota, di stamattina. Senza un secondo
        // tentativo il genitore restava lì fino alla riapertura dopo.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            h.risposte.push(ok([]), () => Promise.resolve({ data: [], offline: true }), ok([PRANZO]));
            render(<ParentDiaryPage />);
            await screen.findByText(itDiario.vuotoTitolo);

            tornaNellApp();
            await waitFor(() => expect(fetchConCache).toHaveBeenCalledTimes(2));
            await lasciaFinire();
            expect(screen.getByText(itDiario.vuotoTitolo)).toBeInTheDocument();

            await act(async () => { vi.advanceTimersByTime(5_000); });

            expect(await screen.findByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
            expect(fetchConCache).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('chi riapre l\'app il giorno dopo trova il diario di oggi, non quello di ieri', async () => {
        // La pagina fissava il giorno all'apertura: con l'app rimasta aperta la notte, il mattino
        // dopo la ricarica rileggeva il giorno prima.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-28T15:00:00Z'));
            h.risposte.push(ok([PRANZO]), ok([]));
            render(<ParentDiaryPage />);
            await screen.findByText(new RegExp(itDiario.quantita_niente));

            vi.setSystemTime(new Date('2026-09-29T07:30:00Z'));
            tornaNellApp();

            expect(await screen.findByText(itDiario.vuotoTitolo)).toBeInTheDocument();
            expect(h.chiavi[1]).toBe('diario:a1:2026-09-29:2026-09-29');
            expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('il tocco su «Diario aggiornato» col diario già aperto riporta a oggi e rilegge', async () => {
        // In Next 16 la navigazione allo stesso percorso non rimonta la pagina: senza l'avviso il
        // tocco lasciava il diario com'era — e sul giorno che il genitore stava guardando.
        h.risposte.push(ok([]), ok([MERENDA_DI_IERI]), ok([PRANZO]));
        render(<ParentDiaryPage />);
        await screen.findByText(itDiario.vuotoTitolo);
        fireEvent.click(screen.getByLabelText(itDiario.giornoPrecedente));
        await screen.findByText(new RegExp(itDiario.quantita_meta));

        act(() => { segnalaNotificaAperta('/parent/diary?id=a1'); });

        expect(await screen.findByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
        expect(h.chiavi[2], 'il tocco non ha riportato a oggi').toBe(h.chiavi[0]);
        expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument();
    });

    it('…e se il diario è già su oggi, il tocco lo rilegge', async () => {
        h.risposte.push(ok([]), ok([PRANZO]));
        render(<ParentDiaryPage />);
        await screen.findByText(itDiario.vuotoTitolo);

        act(() => { segnalaNotificaAperta('/parent/diary?id=a1'); });

        expect(await screen.findByText(new RegExp(itDiario.quantita_niente))).toBeInTheDocument();
        expect(screen.queryByText(itDiario.vuotoTitolo)).not.toBeInTheDocument();
    });
});
