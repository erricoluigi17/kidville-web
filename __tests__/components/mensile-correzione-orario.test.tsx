import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Riepilogo mensile — correggere un'ora senza tornare su «Oggi».
 *
 * Prima la tabella del mese era di sola lettura: l'ora si LEGGEVA (nel `title` e in
 * otto pixel sotto il pallino) ma non si poteva toccare. Per rettificare il ritardo di
 * martedì scorso bisognava tornare al tab «Oggi» e navigare la data indietro — mentre
 * la PATCH accettava già qualunque giorno. Mancava solo il collegamento.
 *
 * DUE VINCOLI che questo file fissa, e nessuno dei due è ovvio:
 *
 *  · la cella è 38×40 px e il bersaglio tattile minimo è 44: l'editor NON ci sta
 *    dentro. La cella è un comando che APRE il chip, non il chip stesso;
 *
 *  · solo le celle con uno stato REALE sono comandi. Una cella vuota prenderebbe 409
 *    `APPELLO_NON_REGISTRATO` — l'appello di quel giorno non è mai stato fatto — e il
 *    rimedio giusto è non offrire il gesto, non mostrare un errore dopo averlo offerto.
 *
 * E una conseguenza che è il vero motivo per cui vale la pena: dopo la correzione il
 * MONTE ORE della riga si ricalcola subito, perché lo somma da questi stessi orari.
 */

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));

const SEZIONE = 'TEST Infanzia';
const SECTION_ID = 'aaaa1111-0000-4000-8000-00000000000a';
const ALUNNO = { id: 'cccc3333-0000-4000-8000-00000000000c', nome: 'Mario', cognome: 'Rossi' };

/** Il 2 del mese in corso: un ritardo, con l'ora. 06:20Z = 08:20 italiane. */
const oggi = new Date();
const ANNO = oggi.getFullYear();
const MESE = oggi.getMonth() + 1;
const GIORNO_ISO = `${ANNO}-${String(MESE).padStart(2, '0')}-02`;

const fetchMock = vi.fn();
const patch = () =>
    fetchMock.mock.calls.filter(
        ([u, init]) => String(u).includes('/api/attendance/daily') &&
            (init as { method?: string } | undefined)?.method === 'PATCH',
    );

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        const u = String(url);
        if (u.includes('/api/diary/students')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => [ALUNNO] });
        }
        if (u.includes('/api/attendance/monthly')) {
            return Promise.resolve({
                ok: true, status: 200, json: async () => [{
                    // La forma vera di `MonthlyAttendanceRecord`: `student_id` e
                    // `date`, non `alunno_id`/`data` (che sono i nomi in colonna).
                    student_id: ALUNNO.id, student_nome: ALUNNO.nome, student_cognome: ALUNNO.cognome,
                    section_name: SEZIONE, date: GIORNO_ISO, stato: 'ritardo',
                    orario_entrata: `${GIORNO_ISO}T06:20:00.000Z`, orario_uscita: null,
                }],
            });
        }
        if (u.includes('/api/attendance/daily') && init?.method === 'PATCH') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);
});

import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';

async function apri() {
    render(<MonthlyAttendanceTable sezione={SEZIONE} sectionId={SECTION_ID} />);
    await waitFor(() => expect(screen.getByText(ALUNNO.cognome, { exact: false })).toBeInTheDocument());
}

const cella = (giorno: string) =>
    document.querySelector(`#cella-${ALUNNO.id}-${giorno}`) as HTMLButtonElement | null;

describe('riepilogo mensile — il refetch non si rimorde la coda', () => {
    it('montare la tabella chiede il mese UNA volta, non a ogni render', async () => {
        // ⚠️ MISURATO IL 2026-09-07: erano SEDICI. `setError(t('...'))` metteva `t` fra
        // le dipendenze di `fetchData`, e `useTranslations` restituisce una funzione
        // nuova a ogni render: l'effect che osserva `fetchData` rifiriva, il
        // `setStudents` provocava un altro render, e il ciclo ricominciava. In esercizio
        // è una schermata che martella il server; qui era anche la ragione per cui una
        // correzione ottimistica veniva sovrascritta dalla risposta successiva.
        await apri();
        await new Promise(r => setTimeout(r, 80));
        const mese = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/attendance/monthly'));
        expect(mese.length).toBeLessThanOrEqual(2); // 1, più il doppio-render di StrictMode
    });
});

describe('riepilogo mensile — la cella con uno stato è un comando', () => {
    it('la cella con uno stato reale è un <button> che NOMINA bambino, giorno e stato', async () => {
        await apri();
        const c = cella(GIORNO_ISO);
        expect(c).not.toBeNull();
        expect(c!.tagName).toBe('BUTTON');
        // In una griglia di trenta colonne «modifica» da solo non dice niente.
        const nome = c!.getAttribute('aria-label') ?? '';
        expect(nome).toContain(ALUNNO.cognome);
        expect(nome).toMatch(/2/);
    });

    it('una cella SENZA appello non è un comando: la PATCH risponderebbe 409', async () => {
        await apri();
        const vuota = `${ANNO}-${String(MESE).padStart(2, '0')}-03`;
        expect(cella(vuota)).toBeNull();
    });

    it('aprendo la cella si corregge l\'ora, e il corpo nomina una colonna sola', async () => {
        await apri();
        fireEvent.click(cella(GIORNO_ISO)!);

        const chip = document.querySelector(`#btn-orario-entrata-${ALUNNO.id}`) as HTMLButtonElement;
        expect(chip).not.toBeNull();
        // L'ora si legge all'orologio di Roma, non in UTC.
        expect(chip.textContent).toContain('08:20');

        fireEvent.click(chip);
        const input = document.querySelector(`#input-orario-entrata-${ALUNNO.id}`) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '09:15' } });
        fireEvent.click(document.querySelector(`#btn-salva-orario-entrata-${ALUNNO.id}`)!);

        await waitFor(() => expect(patch()).toHaveLength(1));
        const corpo = JSON.parse((patch()[0][1] as { body: string }).body) as Record<string, unknown>;
        expect(corpo).toMatchObject({ alunno_id: ALUNNO.id, data: GIORNO_ISO, orario_entrata: '09:15' });
        expect(corpo).not.toHaveProperty('orario_uscita');
        expect(corpo).not.toHaveProperty('stato');
    });

    it('dopo la correzione l\'ora mostrata nel mese è quella nuova', async () => {
        // È il valore vero di questo passo: la riga si aggiorna in locale, quindi il
        // monte ore del mese — che si somma da questi stessi orari — si ricalcola.
        await apri();
        fireEvent.click(cella(GIORNO_ISO)!);
        fireEvent.click(document.querySelector(`#btn-orario-entrata-${ALUNNO.id}`)!);
        const input = document.querySelector(`#input-orario-entrata-${ALUNNO.id}`) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '09:15' } });
        fireEvent.click(document.querySelector(`#btn-salva-orario-entrata-${ALUNNO.id}`)!);

        await waitFor(() => expect(patch()).toHaveLength(1));
        await waitFor(() => {
            const c = cella(GIORNO_ISO);
            expect(c?.textContent).toContain('09:15');
        });
    });
});
