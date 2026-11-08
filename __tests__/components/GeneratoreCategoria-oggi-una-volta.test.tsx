import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// «Oggi» si legge UNA volta: la scadenza proposta e la chiave anti-doppione partono dallo stesso giorno,
// anche se l'orologio passa la mezzanotte di Roma fra una lettura e l'altra.
const letture = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/format/fiscal-date', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/format/fiscal-date')>()),
  // la prima lettura cade il 31 agosto, ogni lettura successiva il 1° settembre (mezzanotte di Roma di mezzo)
  oggiFiscaleISO: () => (letture.n++ === 0 ? '2026-08-31' : '2026-09-01'),
}));

import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria';

beforeEach(() => {
  letture.n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [{ id: 'c1', nome: 'Gita', slug: 'gita' }] }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('GeneratoreCategoria — l\'orologio si legge una volta sola', () => {
  it('scadenza e chiave nascono dallo stesso giorno (31 agosto: anno scolastico 2025), con una sola lettura', async () => {
    const { container } = render(<GeneratoreCategoria userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(screen.getByDisplayValue(/^gita-\d{4}$/)).toBeInTheDocument());
    expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-08-31');
    expect((screen.getByDisplayValue(/^gita-\d{4}$/) as HTMLInputElement).value).toBe('gita-2025');
    expect(letture.n).toBe(1);
  });
});
