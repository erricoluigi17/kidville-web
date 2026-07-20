import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CassaPanel } from '@/components/features/admin/pagamenti/CassaPanel';

// Ruolo lato client controllabile (il gate VERO sono le API): il pannello lo usa
// solo come indizio cosmetico; ciò che decide i KPI è la presenza di `totali`.
const state = vi.hoisted(() => ({ ruolo: 'admin' as string }));
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: state.ruolo, withUser: (h: string) => h }),
}));

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const RIGA_VIRTUALE = {
  id: 'incasso:i1', scuola_id: 'sc-1', tipo: 'entrata', importo: 50, metodo: 'contanti',
  data: '2026-07-20', categoria_id: null, descrizione: 'Retta luglio', note: null, allegato_path: null,
  incasso_id: 'i1', chiusura_id: null, registrato_da: null, creato_il: '2026-07-20T09:00:00Z',
  storno_di: null, stornato_il: null, storno_motivo: null, origine: 'incasso', categoria_nome: null,
};
const RIGA_CASSA = {
  id: 'm1', scuola_id: 'sc-1', tipo: 'uscita', importo: 20, metodo: 'contanti',
  data: '2026-07-20', categoria_id: 'c1', descrizione: 'Detersivi', note: null, allegato_path: null,
  incasso_id: null, chiusura_id: null, registrato_da: 'u1', creato_il: '2026-07-20T10:00:00Z',
  storno_di: null, stornato_il: null, storno_motivo: null, origine: 'cassa', categoria_nome: 'Pulizie e igiene',
};

interface MockOpts {
  movimenti?: unknown[];
  disponibile?: boolean;
  totali?: unknown;
  saldo?: unknown;
}

function installFetch(opts: MockOpts = {}) {
  const { movimenti = [], disponibile = true, totali, saldo } = opts;
  const fn = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/cassa/movimenti')) {
      const body: Record<string, unknown> = { disponibile, movimenti };
      if (totali) body.totali = totali;
      return jsonRes(body);
    }
    if (u.includes('/cassa/saldo')) return jsonRes(saldo ?? { disponibile: false });
    if (u.includes('/cassa/chiusura')) return jsonRes({ disponibile, chiusure: [] });
    if (u.includes('/cassa/report')) return jsonRes({ disponibile, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [] });
    if (u.includes('/cassa/categorie')) return jsonRes({ disponibile, categorie: [] });
    if (u.includes('/admin/settings/categorie')) return jsonRes({ success: true, data: [] });
    if (u.includes('/admin/settings')) return jsonRes({ success: true, data: { cassa_config: {} } });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); state.ruolo = 'admin'; });

describe('CassaPanel — i KPI seguono il payload, non il ruolo client', () => {
  it('senza `totali` nel payload NON renderizza alcun saldo/KPI (il server decide)', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] }); // niente totali
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi'); // tabella desktop + card mobile
    expect(screen.queryByText(/Saldo atteso/i)).toBeNull();
    expect(screen.queryByText(/Saldo/i)).toBeNull();
  });

  it('con `totali` (server = admin) mostra le StatCard KPI', async () => {
    state.ruolo = 'admin';
    installFetch({
      movimenti: [RIGA_CASSA],
      totali: { entrate: 50, uscite_contanti: 20, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
      saldo: { disponibile: true, fondo: 100, saldo_atteso: 130, entrate_contanti: 50, uscite_contanti: 20, prelievi: 0, rettifiche: 0, entrato_oggi: [{ metodo: 'contanti', totale: 50 }] },
    });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    expect(await screen.findByText(/Saldo atteso/i)).toBeInTheDocument();
    expect(screen.getByText(/Entrato oggi/i)).toBeInTheDocument();
    expect(screen.getByText(/Uscite del mese/i)).toBeInTheDocument();
  });
});

describe('CassaPanel — stati e permessi', () => {
  it('con disponibile:false mostra l\'empty-state per la CI non migrata', async () => {
    installFetch({ disponibile: false });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    expect(await screen.findByText(/Modulo cassa non ancora attivo su questo ambiente/i)).toBeInTheDocument();
  });

  it('una riga virtuale «da incasso» non offre lo storno da qui', async () => {
    state.ruolo = 'admin';
    installFetch({
      movimenti: [RIGA_VIRTUALE],
      totali: { entrate: 50, uscite_contanti: 0, uscite_altre: 0, prelievi: 0, rettifiche: 0 },
      saldo: { disponibile: true, fondo: 100, saldo_atteso: 150, entrate_contanti: 50, uscite_contanti: 0, prelievi: 0, rettifiche: 0, entrato_oggi: [] },
    });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Retta luglio');
    expect(screen.getAllByText(/da incasso/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /Storna/ })).toHaveLength(0);
  });

  it('una riga di cassa reale non stornata offre lo storno', async () => {
    state.ruolo = 'admin';
    installFetch({ movimenti: [RIGA_CASSA] });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    expect(screen.queryAllByRole('button', { name: /Storna/ }).length).toBeGreaterThan(0);
  });

  it('la segreteria (nessun `totali`) vede «Registra uscita» ma non «Svuota cassa»', async () => {
    state.ruolo = 'segreteria';
    installFetch({ movimenti: [RIGA_CASSA] });
    render(<CassaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findAllByText('Detersivi');
    expect(screen.getByRole('button', { name: /Registra uscita/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Svuota cassa/i })).toBeNull();
  });
});
