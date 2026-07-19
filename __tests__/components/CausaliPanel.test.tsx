import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CausaliPanel } from '@/components/features/admin/pagamenti/CausaliPanel';
import { DEFAULT_CAUSALE_TEMPLATE } from '@/lib/pagamenti/causale';

// CF SINTETICO nell'anteprima (mai PII reale): coincide con l'esempio di
// PLACEHOLDER_CAUSALE. La sede è quella di produzione (nome pubblico, non PII).
type Patched = { causali_config?: Record<string, string> };

function mockFetch(patched: Patched[], causaliConfig: Record<string, string> = {}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [
        { id: 'c1', nome: 'Gita', slug: 'gita', icona: '🎒', is_sistema: false, ordine: 1 },
        { id: 'c2', nome: 'Mensa', slug: 'mensa', icona: '🍝', is_sistema: true, ordine: 2 },
      ] }) };
    }
    if (init?.method === 'PATCH' && u.startsWith('/api/admin/settings')) {
      patched.push(JSON.parse(String(init.body)) as Patched);
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    }
    if (u.startsWith('/api/admin/settings')) {
      return { ok: true, json: async () => ({ success: true, data: { causali_config: causaliConfig } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('CausaliPanel — modelli di causale per categoria + predefinito', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mostra la riga «Predefinito» + una riga per categoria', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    // Predefinito precompilato col template storico
    await waitFor(() => expect(screen.getByLabelText('Predefinito')).toBeInTheDocument());
    expect((screen.getByLabelText('Predefinito') as HTMLInputElement).value).toBe(DEFAULT_CAUSALE_TEMPLATE);
    // una riga per ciascuna categoria (etichetta = nome, campo vuoto)
    expect(screen.getByLabelText(/Gita/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mensa/)).toBeInTheDocument();
    expect((screen.getByLabelText(/Gita/) as HTMLInputElement).value).toBe('');
  });

  it('l\'anteprima dal vivo riflette il modello digitato', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Quota {descrizione}' } });
    // renderCausale(«Quota {descrizione}», DATI_ESEMPIO) → «Quota Retta Settembre 2026»
    await waitFor(() => expect(screen.getByText('Quota Retta Settembre 2026')).toBeInTheDocument());
  });

  it('un chip inserisce il segnaposto nel campo attivo', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.focus(campo);
    fireEvent.click(screen.getByRole('button', { name: /\{importo\}/ }));
    expect(campo.value).toContain('{importo}');
  });

  it('il salvataggio invia PATCH con causali_config (righe compilate)', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Quota {descrizione}' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0].causali_config?.gita).toBe('Quota {descrizione}');
    // il predefinito resta il template storico (riga compilata → inviata)
    expect(patched[0].causali_config?.default).toBe(DEFAULT_CAUSALE_TEMPLATE);
    // categoria vuota (mensa) → INVIATA come '' così il server la strippa e la
    // chiave torna al Predefinito (svuotare = reset affidabile anche dopo un salvataggio).
    expect(patched[0].causali_config?.mensa).toBe('');
  });
});
