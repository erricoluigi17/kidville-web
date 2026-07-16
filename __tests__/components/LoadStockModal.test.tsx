import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';

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
