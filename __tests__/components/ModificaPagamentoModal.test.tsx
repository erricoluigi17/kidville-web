import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModificaPagamentoModal } from '@/components/features/admin/pagamenti/ModificaPagamentoModal';

/**
 * ─── I METODI AMMESSI NELLA MODIFICA DI UNA VOCE (2026-10-05) ───────────────────────────
 *
 * La PATCH porta `metodi_ammessi` SOLO quando cambiano: sul DB E2E della CI la colonna non
 * c'è, e una modifica normale (descrizione, importo…) non deve toccarla. Zero metodi non si
 * salvano, e il motivo si dice.
 *
 * Dati sintetici: «Gita allo zoo», «Mara Bianchi», uuid finti.
 */
const base = {
  id: 'p-0001',
  descrizione: 'Gita allo zoo',
  importo: 30,
  scadenza: '2026-10-20',
  categoria_id: null,
  obbligatorio: true,
  stato: 'da_pagare',
  importo_pagato: 0,
  sconto: 0,
  alunni: { nome: 'Mara', cognome: 'Bianchi' },
};

let patch: Record<string, unknown>[];
let fetchFinta: ReturnType<typeof vi.fn>;

function rendi(metodi_ammessi?: string[] | null, onDone = vi.fn()) {
  render(
    <ModificaPagamentoModal
      pagamento={{ ...base, metodi_ammessi }}
      categorie={[]}
      userId="u1"
      onClose={() => {}}
      onDone={onDone}
    />,
  );
  return onDone;
}

function patchVerso(): number {
  return fetchFinta.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH').length;
}

beforeEach(() => {
  patch = [];
  fetchFinta = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PATCH' && u === '/api/pagamenti/p-0001') {
      patch.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ success: true }) };
    }
    if (u.startsWith('/api/pagamenti/incassi?')) {
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
  vi.stubGlobal('fetch', fetchFinta);
});
afterEach(() => vi.unstubAllGlobals());

describe('ModificaPagamentoModal — metodi di pagamento ammessi', () => {
  it('voce «solo contanti»: «Bonifico» parte non spuntato; rispuntandolo, la PATCH porta tutti e due', async () => {
    const onDone = rendi(['contanti']);
    expect(await screen.findByText('Nessun incasso registrato.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bonifico' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Bonifico' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));

    await waitFor(() => expect(patch).toHaveLength(1));
    expect(patch[0].metodi_ammessi).toEqual(['contanti', 'bonifico']);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('salvando senza cambiare i metodi, la PATCH NON ha la chiave', async () => {
    rendi(['contanti']);
    await screen.findByText('Nessun incasso registrato.');
    fireEvent.change(screen.getByLabelText('Descrizione'), { target: { value: 'Gita al museo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));

    await waitFor(() => expect(patch).toHaveLength(1));
    // Presenza prima: il corpo è quello della modifica.
    expect(patch[0].descrizione).toBe('Gita al museo');
    expect(patch[0]).not.toHaveProperty('metodi_ammessi');
  });

  it('voce senza colonna (DB della CI): entrambe spuntate, e la PATCH non tocca la colonna', async () => {
    rendi(undefined);
    await screen.findByText('Nessun incasso registrato.');
    expect(screen.getByRole('checkbox', { name: 'Contanti' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bonifico' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));

    await waitFor(() => expect(patch).toHaveLength(1));
    expect(patch[0].descrizione).toBe('Gita allo zoo');
    expect(patch[0]).not.toHaveProperty('metodi_ammessi');
  });

  it('togliere un metodo e rimetterlo è «nessun cambiamento»: niente chiave', async () => {
    rendi(null);
    await screen.findByText('Nessun incasso registrato.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contanti' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contanti' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));

    await waitFor(() => expect(patch).toHaveLength(1));
    expect(patch[0].descrizione).toBe('Gita allo zoo');
    expect(patch[0]).not.toHaveProperty('metodi_ammessi');
  });

  it('zero metodi: niente PATCH, e il perché a schermo', async () => {
    const onDone = rendi(['contanti', 'bonifico']);
    await screen.findByText('Nessun incasso registrato.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contanti' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bonifico' }));
    // Le caselle lo dicono già da sole.
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Salva modifiche' }));
    // Una PRESENZA: anche il salvataggio dice perché non parte (due alert, stesso testo).
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    for (const a of screen.getAllByRole('alert')) {
      expect(a).toHaveTextContent('Scegli almeno un metodo di pagamento.');
    }
    expect(patchVerso()).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
  });
});
