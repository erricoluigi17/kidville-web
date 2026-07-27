import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * Task C5 §2 (punto 4): i due nuovi tipi di notifica (`segnalazione_contenuto`,
 * `conversazione_sospesa`) devono comparire da soli nel pannello Impostazioni →
 * Notifiche, perché il pannello legge dinamicamente `TIPI_NOTIFICA` e raggruppa
 * per `gruppo`. Nessun codice UI dedicato: questo test lo VERIFICA.
 */

vi.mock('@/components/features/admin/settings/useAdminSettings', () => ({
  useAdminSettings: () => ({
    settings: { notifiche_config: { toggles: {} } },
    save: vi.fn(),
    saving: false,
    error: null,
  }),
}));

import { NotificheSettings } from '@/components/features/admin/settings/NotificheSettings';

afterEach(() => cleanup());

describe('Impostazioni → Notifiche: i due nuovi tipi C5 compaiono nel gruppo staff', () => {
  it('mostra i toggle "Segnalazione da moderare" e "Conversazione sospesa"', () => {
    render(<NotificheSettings userId="u1" />);
    expect(screen.getByText(/Segnalazione da moderare/i)).toBeInTheDocument();
    expect(screen.getByText(/Conversazione sospesa/i)).toBeInTheDocument();
  });
});
