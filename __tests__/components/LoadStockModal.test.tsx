import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';
import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default';

// La modale, all'apertura, prova a leggere i materiali configurati: qui rispondiamo
// con array vuoto così resta il fallback (che include "Pannolini").
function mockFetch() {
    return vi.fn(async () => ({ ok: true, json: async () => [] }));
}

const students = [{ id: 's1', nome: 'Anna', cognome: 'Bianchi' }];

function renderModal(onConfirm: (d: { alunno_id: string; materiale: string; quantita: number }) => Promise<void>) {
    return render(
        <LoadStockModal
            isOpen
            onClose={() => {}}
            students={students}
            preselectedStudent="s1"
            preselectedMateriale="Pannolini"
            onConfirm={onConfirm}
        />,
    );
}

describe('LoadStockModal — quantità carico scorte', () => {
    beforeEach(() => vi.stubGlobal('fetch', mockFetch()));
    afterEach(() => vi.unstubAllGlobals());

    it('parte dalla quantità 10 (confezione tipica)', () => {
        renderModal(async () => {});
        expect(screen.getByRole('spinbutton')).toHaveValue(10);
    });

    it('i bottoni ± variano la quantità di 1', () => {
        renderModal(async () => {});
        const input = screen.getByRole('spinbutton');
        fireEvent.click(screen.getByRole('button', { name: 'Aumenta quantità' }));
        expect(input).toHaveValue(11);
        fireEvent.click(screen.getByRole('button', { name: 'Diminuisci quantità' }));
        fireEvent.click(screen.getByRole('button', { name: 'Diminuisci quantità' }));
        expect(input).toHaveValue(9);
    });

    it('si può digitare 7 e salvare 7', async () => {
        const onConfirm = vi.fn(async () => {});
        renderModal(onConfirm);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
        expect(screen.getByRole('spinbutton')).toHaveValue(7);
        fireEvent.click(screen.getByRole('button', { name: /Conferma Carico/i }));
        await waitFor(() =>
            expect(onConfirm).toHaveBeenCalledWith({ alunno_id: 's1', materiale: 'Pannolini', quantita: 7 }),
        );
    });

    it('clampa a 1 i valori non validi (zero, negativi, campo vuoto)', () => {
        renderModal(async () => {});
        const input = screen.getByRole('spinbutton');
        fireEvent.change(input, { target: { value: '0' } });
        expect(input).toHaveValue(1);
        fireEvent.change(input, { target: { value: '-3' } });
        expect(input).toHaveValue(1);
        fireEvent.change(input, { target: { value: '' } });
        expect(input).toHaveValue(1);
    });

    it('la quantità ha una label italiana associata (accessibilità)', () => {
        renderModal(async () => {});
        expect(screen.getByLabelText('Quantità da caricare')).toBe(screen.getByRole('spinbutton'));
    });
});

/**
 * ⚠️ QUESTO È IL LISTINO VERO, non un ripiego teorico.
 *
 * `locker_config` ha ZERO righe in produzione e ci resta per decisione del titolare
 * (2026-09-01): i materiali li aggiungeranno le maestre man mano. Quindi la route
 * `GET /api/locker/materials` risponde `[]` — o i default — a ogni richiesta, e ciò
 * che una maestra vede aprendo il modale di carico è ESATTAMENTE `MATERIALI_DEFAULT`.
 *
 * I cinque test qui sopra non se ne accorgerebbero: passano `preselectedMateriale`
 * come prop, quindi resterebbero verdi anche con `MATERIALI_DEFAULT` vuoto — cioè
 * con un modale in cui non c'è NIENTE da scegliere. Il caso di ogni giorno in
 * produzione era l'unico non sorvegliato. Falsificato apposta il 2026-09-01:
 * con `MATERIALI_DEFAULT: []` il primo dei due test qui sotto diventa rosso.
 */
describe('LoadStockModal — il listino di ripiego è ciò che la maestra vede davvero', () => {
    beforeEach(() => vi.stubGlobal('fetch', mockFetch()));
    afterEach(() => vi.unstubAllGlobals());

    it('senza preselezione e con `locker_config` vuota mostra i quattro materiali di default', async () => {
        render(
            <LoadStockModal
                isOpen
                onClose={() => {}}
                students={students}
                preselectedStudent="s1"
                onConfirm={async () => {}}
            />,
        );

        // La route, con la tabella a zero righe, risponde `[]`: il componente deve
        // restare sul proprio ripiego invece di mostrare una griglia vuota.
        for (const nome of ['Pannolini', 'Salviette', 'Crema', 'Cambio']) {
            expect(
                screen.getByRole('button', { name: new RegExp(nome) }),
                `il modale non offre "${nome}": con locker_config vuota la maestra non ha nulla da scegliere`,
            ).toBeInTheDocument();
        }

        // La lettura dei materiali è partita davvero (altrimenti il test proverebbe
        // solo che il render iniziale funziona, non che il ripiego regge la risposta).
        await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/locker/materials'));
    });

    it('il listino ha quattro voci con le soglie 5/2, 4/2, 3/1, 2/1', () => {
        expect(MATERIALI_DEFAULT).toHaveLength(4);
        expect(
            MATERIALI_DEFAULT.map((m) => [m.nome, m.livello_allerta, m.livello_emergenza]),
        ).toEqual([
            ['Pannolini', 5, 2],
            ['Salviette', 4, 2],
            ['Crema', 3, 1],
            ['Cambio', 2, 1],
        ]);
    });
});
