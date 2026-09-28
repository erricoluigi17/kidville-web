import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import itAdminSettings from '../../../messages/it/adminSettings.json';

/**
 * IMPOSTAZIONI → DIARIO: SOLO COSE CHE FUNZIONANO.
 *
 * Misurato il 2026-09-28: «Compilazione dalle», «Compilazione fino alle» e «Visibile ai genitori
 * dalle» (09:00 in tutte e tre le sedi) venivano salvati e poi non li leggeva NESSUNO. L'unica
 * regola vera è la finestra di correzione (`buffer_visibilita_min`). Il titolare ha deciso di
 * toglierli; stessa sorte a «Note libere dei docenti abilitate», che non leggeva nessuno.
 *
 * Le ROUTINE invece il titolare le vuole funzionanti (2026-09-28, secondo giro): Pasto, Sonno,
 * Cambio, Attività e Umore accendono e spengono davvero i bottoni della maestra, e la segreteria
 * può aggiungere routine sue, scegliendo il tipo di risposta: spunta, scelta fra opzioni (una o
 * più), orario, testo libero.
 */

const h = vi.hoisted(() => ({
  save: vi.fn<(patch: unknown) => Promise<boolean>>(async () => true),
  config: {} as Record<string, unknown>,
}));

vi.mock('@/components/features/admin/settings/useAdminSettings', () => ({
  useAdminSettings: () => ({ settings: { diario_config: h.config }, save: h.save, saving: false, error: null }),
}));

import { DiarioSettings } from '@/components/features/admin/settings/DiarioSettings';
import { SEDE_A } from '../../fixtures/sedi';

const CREMA = { id: 'a1b2c3d4', nome: 'Crema solare', emoji: '🧴', risposta: 'spunta', opzioni: [], multipla: false, attiva: true };

beforeEach(() => {
  // Una sede vera oggi: le chiavi vecchie sono ancora salvate.
  h.config = {
    routine_attive: ['pasto', 'sonno', 'cambio', 'attivita', 'umore'],
    orario_compilazione_da: '08:00',
    orario_compilazione_a: '18:00',
    visibile_genitori_da: '09:00',
    buffer_visibilita_min: 10,
    note_libere_abilitate: true,
  };
});
afterEach(() => { cleanup(); h.save.mockClear(); });

const monta = () => render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />);
const salva = () => fireEvent.click(screen.getByRole('button', { name: /^salva$/i }));
const salvato = () => (h.save.mock.calls[0][0] as { diario_config: Record<string, unknown> }).diario_config;

describe('Impostazioni → Diario: niente campi che non valgono', () => {
  it('la finestra di correzione c\'è; orari, note libere e «prossimamente» no', () => {
    const { container } = monta();
    expect(screen.getByText('Ritardo visibilità genitori (min)')).toBeInTheDocument();
    for (const fantasma of ['Visibile ai genitori dalle', 'Compilazione dalle', 'Compilazione fino alle', 'Note libere dei docenti abilitate', 'prossimamente']) {
      expect(screen.queryByText(fantasma), fantasma).not.toBeInTheDocument();
    }
    // Tolta la traduzione ma non il campo, next-intl stamperebbe il NOME della chiave.
    expect(screen.queryByText(/diVisibileGenitoriDalle|diCompilazione|diNoteLibere/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[type="time"]'), 'è rimasto un campo orario').toHaveLength(0);
  });
});

describe('Impostazioni → Diario: le routine base si accendono e si spengono', () => {
  it('le cinque routine ci sono, e spegnerne una la toglie dal salvataggio', async () => {
    monta();
    const pasto = screen.getByLabelText(itAdminSettings.diRoutinePasto) as HTMLInputElement;
    for (const k of ['diRoutinePasto', 'diRoutineSonno', 'diRoutineCambio', 'diRoutineAttivita', 'diUmore'] as const) {
      expect((screen.getByLabelText(itAdminSettings[k]) as HTMLInputElement).checked, k).toBe(true);
    }
    fireEvent.click(pasto);
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato().routine_attive).toEqual(['sonno', 'cambio', 'attivita', 'umore']);
    expect(salvato(), 'una chiave vecchia persa per strada').toHaveProperty('visibile_genitori_da', '09:00');
  });

  it('una sede che non ha mai scelto mostra le routine di sempre, e non le scrive se non si toccano', async () => {
    h.config = {};
    monta();
    expect((screen.getByLabelText(itAdminSettings.diRoutineSonno) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(itAdminSettings.diUmore) as HTMLInputElement).checked).toBe(false);
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato()).not.toHaveProperty('routine_attive');
  });

  it('i codici dei tipi (seed E2E) si leggono come routine, e si salvano come nomi', async () => {
    h.config = { routine_attive: ['merenda', 'nanna_inizio', 'bagno'] };
    monta();
    expect((screen.getByLabelText(itAdminSettings.diRoutinePasto) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(itAdminSettings.diRoutineAttivita) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(itAdminSettings.diRoutineAttivita));
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato().routine_attive).toEqual(['pasto', 'sonno', 'cambio', 'attivita']);
  });
});

describe('Impostazioni → Diario: le routine della scuola', () => {
  it('se ne aggiunge una a scelta multipla, con le sue opzioni, e si salva con un id suo', async () => {
    monta();
    fireEvent.click(screen.getByRole('button', { name: itAdminSettings.diPersAggiungi }));
    const riga = screen.getAllByTestId('routine-scuola')[0];
    fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersNome), { target: { value: 'Frutta' } });
    fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersEmoji), { target: { value: '🍓' } });
    fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersRisposta), { target: { value: 'scelta' } });
    fireEvent.click(within(riga).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
    fireEvent.click(within(riga).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
    const opzioni = within(riga).getAllByLabelText(new RegExp(itAdminSettings.diPersOpzione));
    fireEvent.change(opzioni[0], { target: { value: 'Mela' } });
    fireEvent.change(opzioni[1], { target: { value: 'Pera' } });
    fireEvent.click(within(riga).getByLabelText(itAdminSettings.diPersMultipla));
    salva();

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const [r] = salvato().routine_personalizzate as Array<Record<string, unknown>>;
    expect(r).toMatchObject({ nome: 'Frutta', emoji: '🍓', risposta: 'scelta', opzioni: ['Mela', 'Pera'], multipla: true, attiva: true });
    expect(r.id).toMatch(/^[a-z0-9]{8}$/);
  });

  it.each([
    ['senza nome', (riga: HTMLElement) => { fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersNome), { target: { value: '' } }); }, itAdminSettings.diPersErrNome],
    ['una scelta con una sola opzione', (riga: HTMLElement) => {
      fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersNome), { target: { value: 'Biberon' } });
      fireEvent.change(within(riga).getByLabelText(itAdminSettings.diPersRisposta), { target: { value: 'scelta' } });
      fireEvent.click(within(riga).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
      fireEvent.change(within(riga).getAllByLabelText(new RegExp(itAdminSettings.diPersOpzione))[0], { target: { value: 'Poco' } });
    }, itAdminSettings.diPersErrOpzioni],
  ])('non si salva una routine %s: lo si dice, e niente parte', async (_caso, compila, errore) => {
    monta();
    fireEvent.click(screen.getByRole('button', { name: itAdminSettings.diPersAggiungi }));
    compila(screen.getAllByTestId('routine-scuola')[0]);
    salva();
    expect(await screen.findByRole('alert')).toHaveTextContent(errore);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('una routine già salvata non cambia tipo di risposta; si rinomina, si spegne, si elimina', async () => {
    h.config = { routine_personalizzate: [CREMA, { ...CREMA, id: 'b0b0b0b0', nome: 'Latte' }] };
    monta();
    const [crema, latte] = screen.getAllByTestId('routine-scuola');
    expect(within(crema).getByLabelText(itAdminSettings.diPersRisposta)).toBeDisabled();
    fireEvent.change(within(crema).getByLabelText(itAdminSettings.diPersNome), { target: { value: 'Crema' } });
    fireEvent.click(within(crema).getByLabelText(itAdminSettings.diPersAttiva));
    fireEvent.click(within(latte).getByRole('button', { name: new RegExp(itAdminSettings.diPersElimina) }));
    salva();

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato().routine_personalizzate).toEqual([{ ...CREMA, nome: 'Crema', attiva: false }]);
  });
});
