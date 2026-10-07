import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Home Direzione (`/admin`): nessuna cifra in euro (titolare, 2026-10-07).
 *
 * La risposta finta di `/api/admin/dashboard` manda ANCORA `scadutoImporto`,
 * `incassatoMese`, `trend` e `importo`: la pagina non deve disegnarli neanche se
 * arrivassero. Il modulo dei grafici è sostituito con uno che esporta SOLO il
 * grafico degli alunni, così se la pagina importasse ancora il grafico degli
 * incassi il test esploderebbe invece di passare in silenzio.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/admin',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', ready: true }),
}));

vi.mock('@/components/features/admin/DashboardCharts', () => ({
  StudentiPerClasseChart: () => <div data-testid="grafico-alunni" />,
}));

const RISPOSTA_DASHBOARD = {
  studenti: { iscritti: 12, perClasse: [{ classe: '2 ANNI', count: 12 }] },
  pagamenti: {
    scadutoImporto: 4321,
    scadutoCount: 1,
    incassatoMese: 8765,
    fattureInAttesa: 2,
  },
  iscrizioni: { pending: 0 },
  mensa: { oggiPrenotazioni: 3 },
  moduli: { submissionTotale: 0, daFirmare: 0 },
  trend: [{ mese: '2026-10', label: 'Ott', incassato: 8765 }],
  alert: {
    scaduti: [{ id: 'pag-1', alunno: 'Prova Collaudo', importo: 4321, scadenza: '2026-01-10' }],
    iscrizioni: [],
  },
};

import AdminDashboardPage from '@/app/(dashboard)/admin/page';

describe('Dashboard admin — nessun importo in euro', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
        if (url.startsWith('/api/admin/dashboard')) return ok(RISPOSTA_DASHBOARD);
        if (url.startsWith('/api/admin/anagrafica-personale')) return ok({ data: [], oggi: '2026-10-07' });
        if (url.startsWith('/api/admin/presenze/realtime')) return ok({ success: false });
        return ok({});
      }),
    );
  });

  it('mostra l\'alunno e la DATA di scadenza, mai l\'importo', async () => {
    const { container } = render(<AdminDashboardPage />);

    // Si aspetta la PRESENZA dei dati: un'assenza passerebbe anche a fetch in volo.
    await waitFor(() => expect(screen.getByText('Prova Collaudo')).toBeInTheDocument());
    expect(screen.getByText('10/01/2026')).toBeInTheDocument();
    expect(screen.getByTestId('grafico-alunni')).toBeInTheDocument();

    const testo = container.textContent ?? '';
    expect(testo).not.toContain('€');
    expect(testo).not.toMatch(/4\.?321|8\.?765/);
    expect(screen.queryByText('Incassato nel mese')).not.toBeInTheDocument();
    expect(screen.queryByText(/Incassi · ultimi 6 mesi/)).not.toBeInTheDocument();
  });
});
