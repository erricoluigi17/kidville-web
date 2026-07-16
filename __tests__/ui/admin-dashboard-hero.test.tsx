import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Re-skin W1 — Home Direzione/Segreteria (`/admin`).
 *
 * La dashboard passa dall'`AuroraHeader` bespoke alla `HeroCard` gialla delle
 * altre home (saluto + data + mascotte). Il heading «Dashboard Direzione» —
 * asserito alla lettera dall'e2e `admin-dashboard.spec.ts:12` con
 * `getByRole('heading', { name: 'Dashboard Direzione' })` — resta VISIBILE come
 * heading di sezione sotto la hero, con la eyebrow di pagina "Direzione".
 *
 * `next/navigation` è stubbato perché `useSessionIdentity` (via la dashboard)
 * usa `useSearchParams`/`usePathname`/`useRouter`; `fetch` è inerte così non
 * parte nessuna chiamata reale (identità non risolta → header sempre renderizzato).
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/admin',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import AdminDashboardPage from '@/app/(dashboard)/admin/page';

describe('Dashboard admin — hero + heading di sezione (re-skin W1)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: async () => ({}) })));
  });

  it('mostra la HeroCard con il saluto e il sottotitolo "Direzione & Segreteria"', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByText('Direzione & Segreteria')).toBeInTheDocument();
    // Il saluto è l'h1 della hero (client-safe via useClientValue).
    expect(
      screen.getByRole('heading', { name: /Buongiorno|Buon pomeriggio|Buonasera/ }),
    ).toBeInTheDocument();
  });

  it('mantiene il heading di sezione ESATTO «Dashboard Direzione» (vincolo e2e)', () => {
    render(<AdminDashboardPage />);
    expect(
      screen.getByRole('heading', { name: 'Dashboard Direzione' }),
    ).toBeInTheDocument();
  });

  it('espone la eyebrow di pagina "Direzione"', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByText('Direzione', { exact: true })).toBeInTheDocument();
  });
});
