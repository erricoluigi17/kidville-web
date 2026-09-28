import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import itAdminSettings from '../../../messages/it/adminSettings.json';

/**
 * IMPOSTAZIONI → DIARIO NON PROMETTE COSE CHE NESSUNO APPLICA.
 *
 * Misurato il 2026-09-28: «Compilazione dalle», «Compilazione fino alle» e «Visibile ai
 * genitori dalle» (09:00 in tutte e tre le sedi) venivano salvati in
 * `admin_settings.diario_config` e poi non li leggeva NESSUNO — né una rotta, né una
 * funzione o una policy del database. L'unica regola vera è la finestra di correzione
 * (`buffer_visibilita_min`, 10 minuti di default): ogni voce diventa visibile al genitore
 * dieci minuti dopo il salvataggio, a qualunque ora. Chi cercava perché il diario
 * «risultava vuoto» leggeva in quel pannello una spiegazione falsa.
 *
 * Il titolare ha deciso di toglierli (non di farli funzionare). Stessa sorte, per la stessa
 * ragione, a ciò che la revisione ha trovato subito dopo: «Note libere dei docenti
 * abilitate» (`note_libere_abilitate`, non la legge nessuno) e quattro routine su cinque —
 * di `routine_attive` il codice legge solo `umore` (`umoreAttivo`): spegnere «Pasto» non
 * toglieva il pasto a nessuno. E il badge «prossimamente» sul pannello intero diceva il
 * contrario del vero per le tre voci che invece funzionano.
 */

const h = vi.hoisted(() => ({ save: vi.fn<(patch: unknown) => Promise<boolean>>(async () => true) }));

vi.mock('@/components/features/admin/settings/useAdminSettings', () => ({
  useAdminSettings: () => ({
    // Una sede vera oggi: le chiavi fantasma sono ancora salvate. Il pannello non deve
    // mostrarle solo perché ci sono.
    settings: {
      diario_config: {
        routine_attive: ['pasto', 'sonno', 'cambio', 'attivita', 'umore'],
        orario_compilazione_da: '08:00',
        orario_compilazione_a: '18:00',
        visibile_genitori_da: '09:00',
        buffer_visibilita_min: 10,
        note_libere_abilitate: true,
      },
    },
    save: h.save,
    saving: false,
    error: null,
  }),
}));

import { DiarioSettings } from '@/components/features/admin/settings/DiarioSettings';
import { SEDE_A } from '../../fixtures/sedi';

afterEach(() => { cleanup(); h.save.mockClear(); });

describe('Impostazioni → Diario: solo ciò che vale davvero', () => {
  it('mostra la finestra di correzione, che vale davvero, e nessuno dei tre orari fantasma', () => {
    const { container } = render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />);

    // Ancora positiva: il pannello è reso, e c'è la regola che si applica davvero.
    expect(screen.getByText('Ritardo visibilità genitori (min)')).toBeInTheDocument();

    expect(screen.queryByText('Visibile ai genitori dalle')).not.toBeInTheDocument();
    expect(screen.queryByText('Compilazione dalle')).not.toBeInTheDocument();
    expect(screen.queryByText('Compilazione fino alle')).not.toBeInTheDocument();
    // Tolta la traduzione ma non il campo, next-intl stamperebbe il NOME della chiave:
    // le frasi qui sopra sparirebbero lo stesso, e il test passerebbe a vuoto.
    expect(screen.queryByText(/diVisibileGenitoriDalle|diCompilazione/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('input[type="time"]'), 'è rimasto un campo orario').toHaveLength(0);
  });

  it('niente «Note libere», niente routine che non spengono niente, niente «prossimamente»', () => {
    render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />);
    expect(screen.getByText('Ritardo visibilità genitori (min)')).toBeInTheDocument();

    expect(screen.queryByText('Note libere dei docenti abilitate')).not.toBeInTheDocument();
    for (const routine of ['Pasto', 'Sonno', 'Cambio', 'Attività']) {
      expect(screen.queryByText(routine), `c'è ancora la routine «${routine}»`).not.toBeInTheDocument();
    }
    expect(screen.queryByText('prossimamente')).not.toBeInTheDocument();
    expect(screen.queryByText(/diNoteLibere|diRoutine/)).not.toBeInTheDocument();
  });

  it('l\'Umore si accende e si spegne, e il salvataggio non tocca le altre voci salvate', async () => {
    render(<DiarioSettings userId="u1" scuolaId={SEDE_A} />);
    const umore = screen.getByLabelText(itAdminSettings.diUmore) as HTMLInputElement;
    expect(umore.checked).toBe(true);

    fireEvent.click(umore);
    expect(umore.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^salva$/i }));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const patch = h.save.mock.calls[0][0] as { diario_config: { routine_attive: string[] } };
    // Le altre quattro restano come sono in archivio: inerti, ma non si cancella niente di nascosto.
    expect(patch.diario_config.routine_attive).toEqual(['pasto', 'sonno', 'cambio', 'attivita']);
  });
});
