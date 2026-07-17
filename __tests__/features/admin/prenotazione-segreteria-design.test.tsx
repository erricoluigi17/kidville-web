import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PrenotazioneSegreteria } from '@/components/features/admin/mensa/PrenotazioneSegreteria';

/**
 * Guard di design della Prenotazione Segreteria (Step 9 — rifinitura mobile).
 *
 * La segreteria inserisce i ticket mensa dal tablet/telefono: i bottoni di
 * selezione dell'alunno sono controlli TOCCABILI e devono avere un touch
 * target generoso (≥44px). Nessuna logica dati nuova, solo rifinitura mobile.
 *
 * Fixture FINTE (mai PII di minori reali).
 */

function stubFetch() {
  return vi.fn((input: unknown) => {
    const u = String(input);
    if (u.includes('/api/admin/students')) {
      return Promise.resolve({
        json: () =>
          Promise.resolve([
            { id: 'a1', nome: 'Bimbo', cognome: 'Uno', classe_sezione: 'Girasoli' },
          ]),
      });
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

describe('PrenotazioneSegreteria — rifinitura mobile (Step 9)', () => {
  it('dà ai bottoni di selezione alunno un touch target ≥44px', async () => {
    render(<PrenotazioneSegreteria userId="u1" scuolaId="s1" />);
    const btn = await screen.findByRole('button', { name: /Bimbo Uno/ });
    expect(btn.className).toContain('min-h-[44px]');
  });
});
