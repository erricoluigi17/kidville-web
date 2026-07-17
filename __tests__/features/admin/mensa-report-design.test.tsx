import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';

/**
 * Guard di design del Report Cucina (Step W4 — Operativo del re-skin segreteria).
 *
 * Il report mensa è una schermata SAFETY-CRITICAL (allergie di minori) usata dalla
 * cuoca su tablet. Il re-skin deve:
 *  (a) preservare il marker `.kv-mensa-alt`, su cui poggiano le regole di Alto
 *      Contrasto in `globals.css` per righe/badge d'allergia;
 *  (b) dare ai controlli touch target generosi (≥44px) per l'uso al tocco.
 */

const reportData = {
  data: '2026-07-16',
  totale: 1,
  perClasse: [
    {
      classe: 'Girasoli',
      conteggio: 1,
      alunni: [{ id: 'a1', nome: 'Bimbo Uno', classe: 'Girasoli', allergeni: ['glutine'], conflitti: [] }],
    },
  ],
  allergie: [],
  alternative_automatiche: [],
};

function stubFetch() {
  return vi.fn((input: unknown) => {
    const u = String(input);
    if (u.includes('/api/mensa/report')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: reportData }) });
    }
    if (u.includes('/api/mensa/alternative')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { alternative: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
  });
}

beforeEach(() => {
  global.fetch = stubFetch() as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MensaReport — Report Cucina (re-skin W4)', () => {
  it('conserva il marker `.kv-mensa-alt` (aggancio delle regole HC di sicurezza)', async () => {
    render(<MensaReport userId="u1" scuolaId="s1" />);
    await screen.findByRole('button', { name: /Registra alternativa/ });
    expect(document.querySelector('.kv-mensa-alt')).not.toBeNull();
  });

  it('dà al bottone «Registra alternativa» un touch target generoso (≥44px)', async () => {
    render(<MensaReport userId="u1" scuolaId="s1" />);
    const btn = await screen.findByRole('button', { name: /Registra alternativa/ });
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('aggancia il marker `.kv-admin-rowcard` alle card classe (HC dello Step 5)', async () => {
    render(<MensaReport userId="u1" scuolaId="s1" />);
    await screen.findByRole('button', { name: /Registra alternativa/ });
    const cards = document.querySelectorAll('.kv-admin-rowcard');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    // la card della classe della fixture ('Girasoli') porta il marker
    expect(Array.from(cards).some((c) => c.textContent?.includes('Girasoli'))).toBe(true);
  });

  it('dà alle righe alunno un touch target ≥44px (colonna singola su mobile)', async () => {
    render(<MensaReport userId="u1" scuolaId="s1" />);
    await screen.findByRole('button', { name: /Registra alternativa/ });
    const nome = screen.getByText('Bimbo Uno');
    const row = nome.closest('li');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('min-h-[44px]');
  });
});
