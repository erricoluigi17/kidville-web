import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

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
});
