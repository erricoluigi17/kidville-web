import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * DUE FIGLI IN DUE PLESSI: IL SELETTORE DEVE DIRE QUALE È QUALE.
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * `ChildSwitcher` mostra, del figlio aperto, nome e `classe_sezione`; dei figli
 * chiusi, due iniziali. Per una famiglia con bambini in due plessi diversi non
 * bastano: i fratelli condividono il cognome, e i nomi delle sezioni si
 * ripetono fra le sedi — «2 ANNI» esiste davvero in più plessi di Kidville.
 * Il genitore si ritrova due chip identici e nessun modo di sapere quale figlio
 * sta guardando: sbagliare figlio significa leggere il diario, le assenze e le
 * comunicazioni dell'altro.
 *
 * Il dato c'era già: `GET /api/parent/students` restituisce `scuola_nome` per
 * ogni figlio (`route.ts:39-69`). A perderlo era il mapping di `caricaFigli`,
 * che teneva quattro campi su undici — quindi la correzione NON aggiunge
 * nessuna chiamata di rete.
 *
 * ─── PERCHÉ SOLO QUANDO LE SEDI DIVERGONO ────────────────────────────────────
 * Perché con i figli nello stesso plesso il nome della sede è rumore: è sempre
 * lo stesso, e occupa spazio in un chip che ne ha poco. La decisione si prende
 * UNA volta per l'intero elenco e non per chip, così l'altezza della riga non
 * cambia mai durante la vita della pagina: su WebKit un elemento che cresce fa
 * risalire il pulsante sotto il dito, ed è un difetto già pagato due volte qui.
 */

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
import { invalidaFigliCache } from '@/lib/auth/use-parent-identity';

const SEDE_UNO = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SEDE_DUE = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Due fratelli, stessa sezione di nome, plessi diversi: il caso peggiore. */
const DUE_PLESSI = [
  { id: 'a1', nome: 'Aurora', cognome: 'Bianchi', classe_sezione: '2 ANNI', scuola_id: SEDE_UNO, scuola_nome: 'Kidville Aversa' },
  { id: 'a2', nome: 'Bruno', cognome: 'Bianchi', classe_sezione: '2 ANNI', scuola_id: SEDE_DUE, scuola_nome: 'Kidville Cesa' },
];

/** Gli stessi due, ma nello stesso plesso. */
const UN_PLESSO = DUE_PLESSI.map((f) => ({ ...f, scuola_id: SEDE_UNO, scuola_nome: 'Kidville Aversa' }));

let figli: Array<Record<string, unknown>> = [];
let chiamate = 0;

beforeEach(() => {
  vi.clearAllMocks();
  invalidaFigliCache();
  chiamate = 0;
  window.localStorage.clear();
  window.localStorage.setItem('kv_user_id', 'P1');
  vi.stubGlobal('fetch', vi.fn((url: unknown) => {
    const u = String(url);
    if (u.includes('/api/parent/students')) {
      chiamate += 1;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: figli }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ChildSwitcher — la sede compare quando serve a distinguere', () => {
  it('figli in DUE plessi: il nome della sede è visibile sul figlio aperto', async () => {
    figli = DUE_PLESSI;
    window.localStorage.setItem('kv_student_id', 'a1');

    render(<ChildSwitcher />);

    // La sezione da sola non basta: si chiamano tutt'e due «2 ANNI».
    await waitFor(() => expect(screen.getByText(/Kidville Aversa/)).toBeTruthy());
    expect(screen.getByText(/2 ANNI/)).toBeTruthy();
  });

  it('figli in due plessi: OGNI chip si distingue anche a voce, non solo quello aperto', async () => {
    // I chip chiusi mostrano due iniziali, e i fratelli hanno lo stesso cognome:
    // senza etichetta accessibile chi naviga con lo screen reader sceglie fra due
    // bottoni che si chiamano uguale.
    figli = DUE_PLESSI;
    window.localStorage.setItem('kv_student_id', 'a1');

    render(<ChildSwitcher />);

    await waitFor(() => expect(screen.getByLabelText('Bruno Bianchi — Kidville Cesa')).toBeTruthy());
    expect(screen.getByLabelText('Aurora Bianchi — Kidville Aversa')).toBeTruthy();
  });

  it('figli nello STESSO plesso: nessun nome di sede, perché non distingue niente', async () => {
    figli = UN_PLESSO;
    window.localStorage.setItem('kv_student_id', 'a1');

    render(<ChildSwitcher />);

    await waitFor(() => expect(screen.getByText(/2 ANNI/)).toBeTruthy());
    expect(screen.queryByText(/Kidville Aversa/)).toBeNull();
  });

  it('la sede non costa nessuna chiamata di rete in più', async () => {
    // Il dato viaggia già dentro `GET /api/parent/students`: se qualcuno un
    // giorno lo andasse a chiedere a parte, questo contatore lo direbbe.
    figli = DUE_PLESSI;
    window.localStorage.setItem('kv_student_id', 'a1');

    render(<ChildSwitcher />);

    await waitFor(() => expect(screen.getByText(/Kidville Aversa/)).toBeTruthy());
    expect(chiamate).toBe(1);
  });

  it('sede assente sul dato (DB non migrato) ⇒ nessuna etichetta, e nessun crash', async () => {
    // Degrado pulito: `scuola_nome` a `null` non deve accendere l'etichetta per
    // tutti né far cadere il componente.
    figli = DUE_PLESSI.map((f) => ({ ...f, scuola_id: null, scuola_nome: null }));
    window.localStorage.setItem('kv_student_id', 'a1');

    render(<ChildSwitcher />);

    await waitFor(() => expect(screen.getByText(/2 ANNI/)).toBeTruthy());
    expect(screen.queryByText(/Kidville/)).toBeNull();
  });
});
