import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

/**
 * CAMBIARE FIGLIO DEVE FUNZIONARE ANCHE QUANDO L'INDIRIZZO NOMINA IL FIGLIO.
 *
 * ─── IL DIFETTO (rilievo del critico, 2026-09-28) ────────────────────────────
 * `ChildSwitcher` salva la scelta in `kv_student_id` e ricarica la pagina. Ma l'identità
 * legge PRIMA l'indirizzo (`getCurrentStudentId`: `?id=` vince, e riscrive pure la cache):
 * su una pagina aperta con `?id=` — i link della home (`withIdentity`) e, dal 2026-09-28,
 * la notifica «Diario aggiornato» — il ricaricamento riportava al figlio di prima. Il
 * genitore toccava l'altro figlio, la pagina lampeggiava e restava com'era.
 *
 * La correzione riscrive l'`id` dell'indirizzo col figlio scelto prima di ricaricare. Gli
 * altri parametri (`userId`, …) restano quelli.
 */

const stub = vi.hoisted(() => ({
  pathname: '/parent/diary',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';
import { invalidaFigliCache } from '@/lib/auth/use-parent-identity';

const FIGLI = [
  { id: 'a1', nome: 'Aurora', cognome: 'Bianchi', classe_sezione: '2 ANNI' },
  { id: 'a2', nome: 'Bruno', cognome: 'Bianchi', classe_sezione: '3 ANNI' },
];

beforeEach(() => {
  invalidaFigliCache();
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_id', 'P1');
  vi.stubGlobal('fetch', vi.fn((url: unknown) => {
    if (String(url).includes('/api/parent/students')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: FIGLI }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('ChildSwitcher — con `?id=` nell\'indirizzo', () => {
  it('scelto l\'altro figlio, l\'indirizzo nomina lui prima di ricaricare', async () => {
    window.history.replaceState(null, '', '/parent/diary?id=a2&userId=P1');
    stub.params = new URLSearchParams('id=a2&userId=P1');

    render(<ChildSwitcher />);
    const aurora = await waitFor(() => {
      const chip = screen.getAllByRole('tab').find((b) => b.getAttribute('aria-selected') === 'false');
      expect(chip).toBeTruthy();
      return chip!;
    });

    fireEvent.click(aurora);

    const dopo = new URLSearchParams(window.location.search);
    expect(dopo.get('id'), 'ricaricando si tornerebbe al figlio di prima').toBe('a1');
    expect(dopo.get('userId')).toBe('P1');
    expect(window.location.pathname).toBe('/parent/diary');
    expect(window.localStorage.getItem('kv_student_id')).toBe('a1');
  });

  it('presidio — senza `?id=` l\'indirizzo resta com\'è', async () => {
    window.history.replaceState(null, '', '/parent?userId=P1');
    stub.params = new URLSearchParams('userId=P1');
    window.localStorage.setItem('kv_student_id', 'a2');

    render(<ChildSwitcher />);
    const aurora = await waitFor(() => {
      const chip = screen.getAllByRole('tab').find((b) => b.getAttribute('aria-selected') === 'false');
      expect(chip).toBeTruthy();
      return chip!;
    });

    fireEvent.click(aurora);

    expect(`${window.location.pathname}${window.location.search}`).toBe('/parent?userId=P1');
    expect(window.localStorage.getItem('kv_student_id')).toBe('a1');
  });
});
