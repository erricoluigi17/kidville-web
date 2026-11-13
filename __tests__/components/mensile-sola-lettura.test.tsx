import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Lotto 6 · rilievo 4 e 8 — la TABELLA DEL MESE, quella vera (non mockata), in sola lettura.
 *
 * Una classe di un anno passato non offre nessun gesto di correzione: le celle con uno stato non sono comandi e il chip con i
 * campi d'orario non esiste. E aprire la correzione su una classe scrivibile, poi passare a una di sola lettura, non lascia il
 * chip a schermo (si azzera al cambio di classe).
 */

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));

const SEZIONE = 'TEST Infanzia';
const SECTION_ID = 'aaaa1111-0000-4000-8000-00000000000a';
const ALUNNO = { id: 'cccc3333-0000-4000-8000-00000000000c', nome: 'Mario', cognome: 'Rossi' };

/**
 * Il 2 del mese in corso: un ritardo, entrato alle 08:20 italiane. L'istante UTC
 * dipende dal mese: 06:20Z con l'ora legale, 07:20Z con la solare. Era cablato a
 * 06:20Z, e dal 1° novembre il test leggeva 07:20 (CI del 01/11/2026).
 */
const oggi = new Date();
const ANNO = oggi.getFullYear();
const MESE = oggi.getMonth() + 1;
const GIORNO_ISO = `${ANNO}-${String(MESE).padStart(2, '0')}-02`;
const scartoRoma = (giorno: string) =>
    Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(`${giorno}T12:00:00Z`))) - 12;
const ENTRATA_UTC = `${GIORNO_ISO}T${String(8 - scartoRoma(GIORNO_ISO)).padStart(2, '0')}:20:00.000Z`;

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes('/api/diary/students')) return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        if (u.includes('/api/attendance/monthly')) {
            return Promise.resolve({
                ok: true, status: 200, json: async () => [{
                    student_id: ALUNNO.id, student_nome: ALUNNO.nome, student_cognome: ALUNNO.cognome,
                    section_name: SEZIONE, date: GIORNO_ISO, stato: 'ritardo', orario_entrata: ENTRATA_UTC, orario_uscita: null,
                }],
            });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';

const cella = () => document.querySelector(`#cella-${ALUNNO.id}-${GIORNO_ISO}`) as HTMLButtonElement | null;
const chip = () => document.querySelector(`#btn-orario-entrata-${ALUNNO.id}`);

describe('tabella del mese — sola lettura', () => {
    it('controllo positivo: scrivibile, la cella con lo stato è un comando', async () => {
        render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} />);
        await waitFor(() => expect(cella()).not.toBeNull());
    });

    it('🔴 in sola lettura la cella con lo stato NON è un comando (resta il solo simbolo)', async () => {
        render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} solaLettura />);
        await waitFor(() => expect(screen.getByText(ALUNNO.cognome, { exact: false })).toBeInTheDocument());
        expect(cella()).toBeNull();
        expect(document.querySelectorAll('td button')).toHaveLength(0);
    });

    it('🔴 la correzione aperta su una classe scrivibile NON resta a schermo passando a una di sola lettura', async () => {
        const { rerender } = render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} />);
        await waitFor(() => expect(cella()).not.toBeNull());
        fireEvent.click(cella()!);
        await waitFor(() => expect(chip()).not.toBeNull());

        rerender(<MonthlyAttendanceTable sezione={SEZIONE} sectionId="aaaa1111-0000-4000-8000-0000000000a2" solaLettura />);
        await waitFor(() => expect(chip()).toBeNull());
    });

    it('🔴 cambiando classe (entrambe scrivibili) la correzione si chiude', async () => {
        const { rerender } = render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} />);
        await waitFor(() => expect(cella()).not.toBeNull());
        fireEvent.click(cella()!);
        await waitFor(() => expect(chip()).not.toBeNull());

        rerender(<MonthlyAttendanceTable sezione={SEZIONE} sectionId="aaaa1111-0000-4000-8000-0000000000a3" />);
        await waitFor(() => expect(chip()).toBeNull());
    });

    it('🔴 la STESSA classe che diventa di sola lettura (anno che si chiude mentre è aperta) chiude la correzione', async () => {
        const { rerender } = render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} />);
        await waitFor(() => expect(cella()).not.toBeNull());
        fireEvent.click(cella()!);
        await waitFor(() => expect(chip()).not.toBeNull());

        rerender(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} solaLettura />);
        await waitFor(() => expect(chip()).toBeNull());
    });
});
