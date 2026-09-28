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
  letturaFallita: false,
  invalida: vi.fn(),
}));

vi.mock('@/components/features/admin/settings/useAdminSettings', () => ({
  useAdminSettings: () => ({ settings: { diario_config: h.config }, save: h.save, saving: false, error: null, letturaFallita: h.letturaFallita }),
}));
vi.mock('@/lib/diary/config-cache', () => ({ invalidaDiarioConfigCache: h.invalida }));

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
afterEach(() => { cleanup(); h.save.mockClear(); h.invalida.mockClear(); h.letturaFallita = false; vi.restoreAllMocks(); });

const monta = () => render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />);
const salva = () => fireEvent.click(screen.getByRole('button', { name: /^salva$/i }));
const salvato = () => (h.save.mock.calls[0][0] as { diario_config: Record<string, unknown> }).diario_config;
const letto = () => (h.save.mock.calls[0][0] as { diario_config_letto: Record<string, unknown> }).diario_config_letto;

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
    // Si manda SOLO ciò che è cambiato (seconda revisione): le chiavi vecchie restano sul server,
    // che unisce, e un pannello aperto da ore non rimanda valori che nel frattempo altri hanno cambiato.
    expect(Object.keys(salvato())).toEqual(['routine_attive']);
    // …insieme a com'era quando il pannello l'ha letto, perché il server se ne accorga (409).
    expect(letto()).toEqual(h.config);
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

  it('i codici dei tipi non toccati non si rimandano: salvare un\'altra impostazione non inciampa su di loro', async () => {
    // Prima si rimandava tutto, e il server accettava solo i NOMI: nella sede E2E (che ha i codici)
    // qualunque salvataggio del diario prendeva 400. Ora il server li converte, e il pannello
    // manda solo ciò che è cambiato.
    h.config = { routine_attive: ['merenda', 'nanna_inizio', 'bagno'] };
    monta();
    fireEvent.click(screen.getByLabelText(itAdminSettings.diEsponiPrimaria));
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato()).toEqual({ diario_primaria_visibile: true });
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
    expect(await screen.findByRole('alert')).toHaveTextContent(errore.replace('«{nome}»', '«Biberon»'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('una routine già salvata non cambia tipo di risposta; si rinomina, si spegne, si elimina', async () => {
    h.config = { routine_personalizzate: [CREMA, { ...CREMA, id: 'b0b0b0b0', nome: 'Latte' }] };
    monta();
    const [crema, latte] = screen.getAllByTestId('routine-scuola');
    expect(within(crema).getByLabelText(itAdminSettings.diPersRisposta)).toBeDisabled();
    fireEvent.change(within(crema).getByLabelText(itAdminSettings.diPersNome), { target: { value: 'Crema' } });
    fireEvent.click(within(crema).getByLabelText(itAdminSettings.diPersAttiva));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(latte).getByRole('button', { name: new RegExp(itAdminSettings.diPersElimina) }));
    salva();

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato().routine_personalizzate).toEqual([{ ...CREMA, nome: 'Crema', attiva: false }]);
  });
});

describe('Impostazioni → Diario: seconda revisione critica (2026-09-28)', () => {
  const riga = (nome: string | RegExp) => screen.getByRole('group', { name: nome });
  const nuova = () => {
    fireEvent.click(screen.getByRole('button', { name: itAdminSettings.diPersAggiungi }));
    return riga(itAdminSettings.diPersNuova);
  };
  const scrivi = (dove: HTMLElement, etichetta: string, valore: string) =>
    fireEvent.change(within(dove).getByLabelText(etichetta), { target: { value: valore } });

  it('ogni routine è un gruppo col suo nome: le etichette ripetute hanno un contesto', () => {
    h.config = { routine_personalizzate: [CREMA, { ...CREMA, id: 'b0b0b0b0', nome: 'Latte' }] };
    monta();
    expect(within(riga('Crema solare')).getByLabelText(itAdminSettings.diPersNome)).toHaveValue('Crema solare');
    expect(within(riga('Latte')).getByLabelText(itAdminSettings.diPersNome)).toHaveValue('Latte');
  });

  it('Scelta → un\'opzione vuota → di nuovo Spunta: si salva, e le opzioni nascoste se ne vanno', async () => {
    monta();
    const r = nuova();
    scrivi(r, itAdminSettings.diPersNome, 'Crema');
    scrivi(r, itAdminSettings.diPersRisposta, 'scelta');
    fireEvent.click(within(r).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
    fireEvent.click(within(r).getByLabelText(itAdminSettings.diPersMultipla));
    scrivi(r, itAdminSettings.diPersRisposta, 'spunta');
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const [salvata] = salvato().routine_personalizzate as Array<Record<string, unknown>>;
    expect(salvata).toMatchObject({ risposta: 'spunta', opzioni: [], multipla: false });
  });

  it.each([
    ['un\'opzione vuota', (r: HTMLElement) => {
      scrivi(r, itAdminSettings.diPersRisposta, 'scelta');
      for (let i = 0; i < 3; i++) fireEvent.click(within(r).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
      const campi = within(r).getAllByLabelText(new RegExp(itAdminSettings.diPersOpzione));
      fireEvent.change(campi[0], { target: { value: 'Poco' } });
      fireEvent.change(campi[1], { target: { value: 'Tutto' } });
    }, 'diPersErrOpzioneVuota'],
    ['un\'icona che non è un simbolo', (r: HTMLElement) => scrivi(r, itAdminSettings.diPersEmoji, 'CREMA'), 'diPersErrIcona'],
  ] as const)('%s: lo si dice NOMINANDO la routine, e niente parte', async (_caso, guasta, chiave) => {
    monta();
    const r = nuova();
    scrivi(r, itAdminSettings.diPersNome, 'Biberon');
    guasta(r);
    salva();
    const avviso = await screen.findByRole('alert');
    expect(avviso).toHaveTextContent(itAdminSettings[chiave].replace('«{nome}»', '«Biberon»'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('due routine con lo stesso nome: lo si dice, e niente parte', async () => {
    h.config = { routine_personalizzate: [CREMA] };
    monta();
    scrivi(nuova(), itAdminSettings.diPersNome, 'crema solare');
    salva();
    expect(await screen.findByRole('alert')).toHaveTextContent(itAdminSettings.diPersErrNomeDoppio.replace('{nome}', 'crema solare'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('eliminare una routine GIÀ SALVATA chiede conferma; «Annulla» la lascia dov\'è', () => {
    h.config = { routine_personalizzate: [CREMA] };
    monta();
    const conferma = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(riga('Crema solare')).getByRole('button', { name: new RegExp(itAdminSettings.diPersElimina) }));
    expect(conferma).toHaveBeenCalledTimes(1);
    expect(riga('Crema solare')).toBeInTheDocument();
  });

  it('una routine appena aggiunta (mai salvata) si toglie senza domande', () => {
    monta();
    const conferma = vi.spyOn(window, 'confirm');
    fireEvent.click(within(nuova()).getByRole('button', { name: new RegExp(itAdminSettings.diPersElimina) }));
    expect(conferma).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: itAdminSettings.diPersNuova })).not.toBeInTheDocument();
  });

  it('al limite delle opzioni il bottone si spegne e il perché si legge', () => {
    monta();
    const r = nuova();
    scrivi(r, itAdminSettings.diPersRisposta, 'scelta');
    for (let i = 0; i < 10; i++) fireEvent.click(within(r).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi }));
    expect(within(r).getByRole('button', { name: itAdminSettings.diPersOpzioneAggiungi })).toBeDisabled();
    expect(within(r).getByText('Al massimo 10 opzioni.')).toBeInTheDocument();
  });

  it('se le impostazioni salvate non si sono lette, il salvataggio è bloccato e lo si dice', () => {
    // Il pannello partirebbe da `{}`: salvare riscriverebbe le routine della scuola da zero.
    h.letturaFallita = true;
    monta();
    expect(screen.getByRole('button', { name: /^salva$/i })).toBeDisabled();
    expect(screen.getByText(itAdminSettings.diLetturaFallitaBlocco)).toBeInTheDocument();
  });

  it('dopo un salvataggio riuscito la configurazione del diario in cache si butta', async () => {
    monta();
    fireEvent.click(screen.getByLabelText(itAdminSettings.diRoutinePasto));
    salva();
    await waitFor(() => expect(h.invalida).toHaveBeenCalledTimes(1));
  });
});

describe('Impostazioni → Diario: terzo giro della revisione (2026-09-28)', () => {
  it('svuotare il ritardo di visibilità e salvare NON manda 0 minuti', async () => {
    // `Number('')` vale 0: il campo vuoto diventava «nessuna finestra di correzione».
    h.config = { buffer_visibilita_min: 10 };
    const { container } = monta();
    const campo = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '' } });
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(salvato().buffer_visibilita_min ?? null).toBeNull();
  });

  it('una modifica fatta MENTRE il salvataggio è in volo non si perde', async () => {
    let risolvi: (v: boolean) => void = () => {};
    h.save.mockImplementationOnce(() => new Promise<boolean>((r) => { risolvi = r; }));
    monta();
    fireEvent.click(screen.getByLabelText(itAdminSettings.diRoutinePasto));
    salva();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(itAdminSettings.diRoutineSonno));
    risolvi(true);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect((screen.getByLabelText(itAdminSettings.diRoutineSonno) as HTMLInputElement).checked).toBe(false);
  });
});
