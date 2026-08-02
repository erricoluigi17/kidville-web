import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { SEDE_B } from '../fixtures/sedi';

/**
 * W3-E — Il giro completo della sede: anche le SCRITTURE di `MensaReport`.
 *
 * `mensa/alternative` POST e DELETE risolvono la sede con `resolveScuolaScrittura`,
 * che dal 2026-07-31 risponde davvero 400 quando l'utente ha più plessi e nessuno
 * è indicato. `MensaReport` mandava `scuola_id` solo sulle LETTURE (report e
 * elenco): registrare o togliere un'alternativa alimentare dalla Direzione
 * multi-sede finiva quindi in un 400 — con il pannello che mostra un errore che
 * l'operatore non può risolvere, perché la sede l'aveva già scelta.
 *
 * L'alternativa alimentare non è un dettaglio: è ciò che un bambino allergico
 * mangia a pranzo.
 */

const reportData = {
  data: '2026-07-31',
  totale: 1,
  perClasse: [
    { classe: '2 ANNI', conteggio: 1, alunni: [{ id: 'alu-1', nome: 'Bimbo Uno', classe: '2 ANNI', allergeni: [], conflitti: [] }] },
  ],
  allergie: [],
  alternative_automatiche: [],
};

const alternativa = {
  id: 'alt-1',
  alunno_id: 'alu-1',
  nome: 'Bimbo Uno',
  classe: '2 ANNI',
  richiesta: 'Pasta in bianco',
  origine: 'segreteria',
  created_at: '2026-07-31T10:00:00Z',
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/api/mensa/report')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: reportData }) });
    if (u.includes('/api/mensa/alternative')) return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { alternative: [alternativa] } }) });
    return Promise.resolve({ ok: true, json: async () => ({ success: false }) });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => cleanup());

const chiamate = (metodo: string) =>
  fetchMock.mock.calls.filter((c) => ((c[1] as { method?: string } | undefined)?.method ?? 'GET') === metodo);

describe('MensaReport — la sede viaggia anche sulle scritture', () => {
  it('registrare un\'alternativa dichiara la sede nel body', async () => {
    render(<MensaReport userId="seg-1" scuolaId={SEDE_B} sezione="2 ANNI" />);
    // Il nome compare due volte (elenco della classe + tendina del form).
    await waitFor(() => expect(screen.getAllByText(/Bimbo Uno/).length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText(/bambino/i), { target: { value: 'alu-1' } });
    fireEvent.change(screen.getByLabelText(/nota/i), { target: { value: 'Pasta in bianco' } });
    fireEvent.click(screen.getByRole('button', { name: /registra/i }));

    await waitFor(() => expect(chiamate('POST')).toHaveLength(1));
    const body = JSON.parse(String((chiamate('POST')[0][1] as { body: string }).body));
    expect(body.scuola_id).toBe(SEDE_B);
    expect(body.alunno_id).toBe('alu-1');
  });

  it('eliminare un\'alternativa dichiara la sede in query', async () => {
    render(<MensaReport userId="seg-1" scuolaId={SEDE_B} sezione="2 ANNI" />);
    // Il testo della richiesta passa da un'interpolazione i18n (che il mock dei
    // messaggi non risolve): il bottone di eliminazione è l'ancora stabile.
    const elimina = await screen.findByTitle(/elimina/i);

    fireEvent.click(elimina);

    await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1));
    expect(String(chiamate('DELETE')[0][0])).toContain(`scuola_id=${SEDE_B}`);
  });
});
