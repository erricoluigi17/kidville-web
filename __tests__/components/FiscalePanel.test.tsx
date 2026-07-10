import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FiscalePanel } from '@/components/features/admin/pagamenti/FiscalePanel';

// Contabilità = solo frequentanti: gli iscritti SENZA sezione non devono
// comparire nemmeno nella lista attestazioni.
describe('FiscalePanel — filtro frequentanti', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith('/api/pagamenti/ricevute')) {
        return { ok: true, json: async () => ({ success: true, data: [], disponibile: false }) };
      }
      if (u.startsWith('/api/admin/students')) {
        return {
          ok: true,
          json: async () => ({ success: true, data: [
            { id: 'a1', nome: 'Mario', cognome: 'Rossi', classe_sezione: '1A', section_id: null },
            { id: 'a2', nome: 'Ugo', cognome: 'Verdi', classe_sezione: null, section_id: null },
          ] }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lista solo gli alunni assegnati a una sezione', async () => {
    render(<FiscalePanel userId="u1" scuolaId="sc-1" />);
    await waitFor(() => expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument());
    expect(screen.queryByText(/Ugo Verdi/)).toBeNull();
  });
});
