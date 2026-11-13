import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

/**
 * Lotto 6 · L6-4 — l'elenco dei figli si RILEGGE: quando l'app torna in primo piano e quando passa abbastanza tempo,
 * non solo all'accesso.
 *
 * Causa letta nel codice: `fetchEsitoFigli` è una cache di promesse di modulo che si svuota solo al cambio di account.
 * Una sessione aperta prima del passaggio d'anno teneva l'elenco di allora per sempre: il figlio USCITO restava il primo
 * (`kv_student_id` lo rivalidava contro la lista vecchia, che lo conteneva ancora).
 *
 * Il finto server cambia risposta DOPO la prima lettura (il passaggio avviene mentre l'app è aperta): un finto che risponde
 * sempre uguale sarebbe verde anche senza la correzione.
 */

const stub = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/parent',
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

import { fetchEsitoFigli, invalidaFigliCache, useParentIdentity } from '@/lib/auth/use-parent-identity';

const USCITO = 'a0000000-0000-4000-8000-000000000001';
const ATTIVO = 'a0000000-0000-4000-8000-000000000002';
const P = 'p0000000-0000-4000-8000-000000000001';

let letture: number;
let dopoPassaggio: boolean;
const fetchMock = vi.fn();

function Sonda() {
  const { studentId, figliIds, ready } = useParentIdentity();
  return <div data-testid="sonda">{ready ? `${studentId}|${figliIds.join(',')}` : 'non-pronto'}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidaFigliCache();
  letture = 0;
  dopoPassaggio = false;
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_id', P);
  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('/api/parent/students')) {
      letture += 1;
      const data = dopoPassaggio
        ? [{ id: ATTIVO, nome: 'B', cognome: 'C', classe_sezione: 'X' }]
        : [{ id: USCITO, nome: 'A', cognome: 'C', classe_sezione: 'X' }, { id: ATTIVO, nome: 'B', cognome: 'C', classe_sezione: 'X' }];
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('elenco figli — si rilegge (L6-4)', () => {
  it('fra due letture ravvicinate la richiesta è UNA sola (la deduplica resta)', async () => {
    await fetchEsitoFigli(P);
    await fetchEsitoFigli(P);
    expect(letture).toBe(1);
  });

  it('passato il tempo, la lettura riparte dal server e vede il passaggio avvenuto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-09-10T08:00:00Z'));
    expect((await fetchEsitoFigli(P))?.figli.map((f) => f.id)).toEqual([USCITO, ATTIVO]);
    dopoPassaggio = true;
    vi.setSystemTime(new Date('2027-09-10T08:05:00Z'));
    expect((await fetchEsitoFigli(P))?.figli.map((f) => f.id)).toEqual([ATTIVO]);
    expect(letture).toBe(2);
  });

  it('l’app torna in primo piano dopo il passaggio: il figlio uscito non è più il primo', async () => {
    window.localStorage.setItem('kv_student_id', USCITO);
    render(<Sonda />);
    await waitFor(() => expect(screen.getByTestId('sonda').textContent).toBe(`${USCITO}|${USCITO},${ATTIVO}`));

    dopoPassaggio = true; // il passaggio avviene mentre l'app è aperta
    const nascondi = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    await act(async () => { nascondi(true); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); nascondi(false); });

    await waitFor(() => expect(screen.getByTestId('sonda').textContent).toBe(`${ATTIVO}|${ATTIVO}`));
    expect(window.localStorage.getItem('kv_student_id')).toBe(ATTIVO);
  });
});
