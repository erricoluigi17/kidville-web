import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * UNA sola GET a /api/parent/students per caricamento di pagina genitore.
 *
 * Il difetto misurato (T11-F3, allargato): l'elenco dei figli è chiesto da
 * OGNI consumatore di `useParentIdentity` — la home, `useChildSchoolType`
 * (che a sua volta è dentro la home E dentro BottomNav) e `ChildSwitcher`,
 * che per giunta ne faceva una tutta sua per avere nomi e sezione. Cinque
 * richieste identiche allo stesso endpoint, in parallelo, a ogni ingresso.
 *
 * Il test NON verifica che esista una cache: conta le RICHIESTE che escono
 * davvero. Una cache aggiunta e poi ignorata (si chiama e si butta via il
 * risultato) riporta il contatore a 5 e questo test torna rosso.
 *
 * Il secondo caso è quello pericoloso, ed è il motivo per cui la deduplica va
 * misurata e non solo scritta: una cache con una chiave sbagliata (fissa, o
 * non indicizzata sul genitore) mostrerebbe a un genitore i figli di un altro.
 * È un rimedio peggiore del male, e su dati di minori non è un'ipotesi teorica.
 */

// Riferimenti STABILI: `useSearchParams` e `useRouter` finiscono nelle deps
// degli effect dell'identità. Restituire un oggetto nuovo a ogni render manda
// in loop il componente (e non è un difetto del prodotto, è del finto).
const stub = vi.hoisted(() => ({
  pathname: '/parent',
  params: new URLSearchParams(),
  router: { push: () => {}, replace: () => {}, refresh: () => {} },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => stub.pathname,
  useSearchParams: () => stub.params,
  useRouter: () => stub.router,
}));

import { ChildSwitcher } from '@/components/features/parent/ChildSwitcher';
import BottomNav from '@/components/features/parent/BottomNav';
import ParentHome from '@/app/(dashboard)/parent/page';
import { fetchFigli, invalidaFigliCache } from '@/lib/auth/use-parent-identity';

interface Anagrafica { id: string; nome: string; cognome: string; classe_sezione?: string | null }

/** Figli per genitore: chi chiede con la chiave sbagliata prende quelli altrui. */
const FIGLI: Record<string, Anagrafica[]> = {
  P1: [
    { id: 'a1', nome: 'Aurora', cognome: 'Bianchi', classe_sezione: 'Girasoli' },
    { id: 'a2', nome: 'Bruno', cognome: 'Bianchi', classe_sezione: 'Girasoli' },
  ],
  P2: [
    { id: 'c1', nome: 'Chiara', cognome: 'Verdi', classe_sezione: 'Coccinelle' },
    { id: 'c2', nome: 'Dario', cognome: 'Verdi', classe_sezione: 'Coccinelle' },
  ],
};

let chiamateStudents: string[] = [];
const fetchMock = vi.fn();

function rispostaVuota() {
  return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidaFigliCache();
  chiamateStudents = [];
  window.localStorage.clear();
  stub.pathname = '/parent';
  stub.params = new URLSearchParams();
  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('/api/parent/students')) {
      chiamateStudents.push(u);
      const parentId = new URL(u, 'http://x').searchParams.get('userId') ?? '';
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: FIGLI[parentId] ?? [] }),
      });
    }
    // La card presenze si aspetta un oggetto, non un elenco: con `data: []`
    // andrebbe in errore per una forma sbagliata del FINTO, non per il difetto
    // in esame. Le si risponde "dato non disponibile", che è un caso previsto.
    if (u.includes('/api/parent/presenze')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false }) });
    }
    return Promise.resolve(rispostaVuota());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('elenco figli — la stessa GET non parte cinque volte', () => {
  it('home + BottomNav + ChildSwitcher insieme: UNA sola /api/parent/students', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');

    render(
      <>
        <ChildSwitcher />
        <ParentHome />
        <BottomNav />
      </>,
    );

    // Si aspetta che il selettore abbia i dati (cioè che la fetch sia servita).
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));

    expect(
      chiamateStudents.length,
      "L'elenco dei figli è stato chiesto più di una volta nello stesso caricamento: "
        + 'ogni consumatore di useParentIdentity apre la propria richiesta. '
        + `Richieste osservate: ${chiamateStudents.length} → ${chiamateStudents.join(' | ')}`,
    ).toBe(1);
  });

  it('genitori DIVERSI = liste diverse: la cache non può essere condivisa fra parentId', async () => {
    window.localStorage.setItem('kv_user_id', 'P1');
    const primo = render(<ChildSwitcher />);
    await waitFor(() => expect(screen.getByText('Aurora')).toBeInTheDocument());
    primo.unmount();

    // Secondo genitore, stessa sessione del browser (cambio account senza reload).
    window.localStorage.clear();
    window.localStorage.setItem('kv_user_id', 'P2');
    render(<ChildSwitcher />);

    await waitFor(() => expect(screen.getByText('Chiara')).toBeInTheDocument());
    expect(
      screen.queryByText('Aurora'),
      'Il genitore P2 sta vedendo un figlio di P1: la cache dei figli non è '
        + 'indicizzata sul genitore. Questo è peggio delle chiamate duplicate.',
    ).not.toBeInTheDocument();
    expect(
      chiamateStudents.length,
      'Due genitori diversi devono produrre due richieste diverse. '
        + `Richieste osservate: ${chiamateStudents.join(' | ')}`,
    ).toBe(2);
  });

  it('due richieste contemporanee per lo stesso genitore = una sola sulla rete', async () => {
    const [a, b] = await Promise.all([fetchFigli('P1'), fetchFigli('P1')]);
    expect(a?.map((f) => f.id)).toEqual(['a1', 'a2']);
    expect(b?.map((f) => f.id)).toEqual(['a1', 'a2']);
    expect(chiamateStudents).toHaveLength(1);
  });

  it('esito non determinabile (rete giù) NON si congela: il tentativo dopo richiama', async () => {
    fetchMock.mockImplementationOnce((url: unknown) => {
      chiamateStudents.push(String(url));
      return Promise.reject(new Error('offline'));
    });

    expect(await fetchFigli('P1')).toBeNull();
    // Rete tornata: il mount successivo deve ritentare, non riusare il null.
    const dopo = await fetchFigli('P1');
    expect(dopo?.map((f) => f.id)).toEqual(['a1', 'a2']);
    expect(chiamateStudents).toHaveLength(2);
  });
});
