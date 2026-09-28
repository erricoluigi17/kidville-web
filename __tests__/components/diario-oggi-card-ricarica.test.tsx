import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

import itHome from '../../messages/it/home.json';

/**
 * LA CARD «OGGI A SCUOLA» DELLA HOME SI RICARICA QUANDO SI TORNA NELL'APP.
 *
 * Stesso difetto della pagina del diario (2026-09-28): la card leggeva le voci una volta
 * sola, al montaggio. Aperta al mattino diceva «Ancora nessun aggiornamento del diario per
 * oggi» e continuava a dirlo tutto il giorno a chi riapriva l'app dalla home — anche con
 * le voci della maestra già scritte. E da vuota la card non porta nemmeno al diario
 * completo: il genitore non aveva nessun motivo per andare a controllare.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }));
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }));

import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';

const PRANZO = { id: 'e1', tipo_evento: 'pranzo', timestamp_evento: new Date().toISOString(),
    dettagli: { corsi: { primo: 'tutto' } }, note: null };

const h = vi.hoisted(() => ({ risposte: [] as Array<() => Promise<unknown>> }));

beforeEach(() => {
    vi.clearAllMocks();
    h.risposte = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', vi.fn(async () => {
        const prossima = h.risposte.shift();
        if (!prossima) throw new Error('nessuna risposta preparata');
        return prossima();
    }));
});

const voci = (corpo: unknown) => () => Promise.resolve({ ok: true, status: 200, json: async () => corpo });
const rete = () => () => Promise.reject(new TypeError('Load failed'));

function tornaNellApp() {
    act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

describe('card «Oggi a scuola» — si ricarica al ritorno nell\'app', () => {
    it('vuota all\'apertura, al ritorno mostra le voci scritte nel frattempo', async () => {
        h.risposte.push(voci([]), voci([PRANZO]));
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        await screen.findByText(itHome.diaryVuoto);

        tornaNellApp();

        expect(await screen.findByText(itHome.titoloOggiAScuola)).toBeInTheDocument();
        expect(screen.getByText(itHome.diaryApriCompleto)).toBeInTheDocument();
        expect(screen.queryByText(itHome.diaryVuoto)).not.toBeInTheDocument();
    });

    it('se al ritorno la rete non risponde, le voci già mostrate restano', async () => {
        h.risposte.push(voci([PRANZO]), rete());
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        await screen.findByText(itHome.titoloOggiAScuola);

        tornaNellApp();
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

        expect(screen.getByText(itHome.titoloOggiAScuola)).toBeInTheDocument();
        expect(screen.queryByText(itHome.diaryVuoto)).not.toBeInTheDocument();
    });

    it('se il diario non si legge, la card lo dice: mai «Ancora nessun aggiornamento»', async () => {
        // Fino al 2026-09-28 una lettura fallita diventava la frase del diario vuoto.
        h.risposte.push(rete(), voci([PRANZO]));
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);

        expect(await screen.findByText(itHome.diaryNonLetto)).toBeInTheDocument();
        expect(screen.queryByText(itHome.diaryVuoto)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: itHome.diaryRiprova }));
        expect(await screen.findByText(itHome.titoloOggiAScuola)).toBeInTheDocument();
    });

    it('cambiato figlio, una lettura fallita non lascia a schermo il diario dell\'altro', async () => {
        // La regola «una lettura fallita non svuota la card» vale per il ritorno nell'app, non
        // per il cambio di figlio: lì le voci a schermo sono di un altro bambino.
        let fallisci: (e: unknown) => void = () => {};
        h.risposte.push(voci([PRANZO]), () => new Promise((_, rifiuta) => { fallisci = rifiuta; }));
        const { rerender } = render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        await screen.findByText(itHome.titoloOggiAScuola);

        rerender(<DiaryTodayCard studentId="a2" href="/parent/diary" />);
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        // Anche MENTRE la lettura del nuovo figlio è in volo, il diario dell'altro non si vede.
        expect(screen.queryByText(itHome.titoloOggiAScuola), 'in attesa, mostra il figlio di prima').not.toBeInTheDocument();

        await act(async () => { fallisci(new TypeError('Load failed')); });
        expect(await screen.findByText(itHome.diaryNonLetto)).toBeInTheDocument();
        expect(screen.queryByText(itHome.titoloOggiAScuola), 'mostra il diario del figlio di prima').not.toBeInTheDocument();
    });

    it('al ritorno, se la lettura fallisce, si riprova da sola qualche secondo dopo', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            h.risposte.push(voci([]), rete(), voci([PRANZO]));
            render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
            await screen.findByText(itHome.diaryVuoto);

            tornaNellApp();
            await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
            await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
            expect(screen.getByText(itHome.diaryVuoto)).toBeInTheDocument();

            await act(async () => { vi.advanceTimersByTime(5_000); });

            expect(await screen.findByText(itHome.titoloOggiAScuola)).toBeInTheDocument();
            expect(fetch).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('un ritorno mentre la prima lettura è ancora in volo la aspetta, invece di scavalcarla', async () => {
        // Stessa gara della pagina del diario: la ricarica prendeva il posto della lettura in volo
        // e, se falliva, buttava via la risposta buona che stava arrivando.
        let rispondi: (v: unknown) => void = () => {};
        h.risposte.push(() => new Promise((r) => { rispondi = r; }), rete());
        render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

        tornaNellApp();
        await act(async () => { rispondi({ ok: true, status: 200, json: async () => [PRANZO] }); });

        expect(await screen.findByText(itHome.titoloOggiAScuola)).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('il giorno dopo, una lettura fallita non spaccia le voci di ieri per quelle di oggi', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-28T15:00:00Z'));
            h.risposte.push(voci([PRANZO]), rete());
            render(<DiaryTodayCard studentId="a1" href="/parent/diary" />);
            await screen.findByText(itHome.titoloOggiAScuola);

            vi.setSystemTime(new Date('2026-09-29T07:30:00Z'));
            tornaNellApp();

            expect(await screen.findByText(itHome.diaryNonLetto)).toBeInTheDocument();
            expect(screen.queryByText(itHome.titoloOggiAScuola)).not.toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });
});
