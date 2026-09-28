import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * IMPOSTAZIONI → DIARIO NON PROMETTE ORARI CHE NESSUNO APPLICA.
 *
 * Misurato il 2026-09-28: «Compilazione dalle», «Compilazione fino alle» e «Visibile ai
 * genitori dalle» (09:00 in tutte e tre le sedi) venivano salvati in
 * `admin_settings.diario_config` e poi non li leggeva NESSUNO — né una rotta, né una
 * funzione o una policy del database. L'unica regola vera è la finestra di correzione
 * (`buffer_visibilita_min`, 10 minuti di default): ogni voce diventa visibile al genitore
 * dieci minuti dopo il salvataggio, a qualunque ora. Chi cercava perché il diario
 * «risultava vuoto» leggeva in quel pannello una spiegazione falsa.
 *
 * Il titolare ha deciso di toglierli (non di farli funzionare).
 */

vi.mock('@/components/features/admin/settings/useAdminSettings', () => ({
  useAdminSettings: () => ({
    // Una sede vera oggi: le tre chiavi sono ancora salvate. Il pannello non deve
    // mostrarle solo perché ci sono.
    settings: {
      diario_config: {
        routine_attive: ['pasto', 'sonno', 'cambio', 'attivita'],
        orario_compilazione_da: '08:00',
        orario_compilazione_a: '18:00',
        visibile_genitori_da: '09:00',
        buffer_visibilita_min: 10,
      },
    },
    save: vi.fn(),
    saving: false,
    error: null,
  }),
}));

import { DiarioSettings } from '@/components/features/admin/settings/DiarioSettings';
import { SEDE_A } from '../../fixtures/sedi';

afterEach(() => cleanup());

describe('Impostazioni → Diario: niente orari che non valgono', () => {
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
});
