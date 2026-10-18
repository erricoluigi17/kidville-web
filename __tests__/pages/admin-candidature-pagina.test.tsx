import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itAdminAltro from '../../messages/it/adminAltro.json';

/**
 * «/admin/candidature» — la pagina propria delle candidature «Lavora con noi».
 *
 * Fino al 2026-10-17 erano la quarta linguetta di Modulistica. Qui si monta la pagina nuova e
 * si guarda che dica di sé il nome giusto (dal catalogo ITALIANO vero, non da una stringa
 * scritta qui) e che sotto ci sia il pannello delle candidature, non un vuoto.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/admin/candidature',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Il pannello è provato nei suoi file (`CandidatureInsegnanti*.test.tsx`): qui interessa che
// la pagina lo monti. Un mock che rende `null` non distinguerebbe «montato» da «dimenticato».
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({
  CandidatureInsegnanti: () => <div data-testid="pannello-candidature" />,
}));

import AdminCandidaturePage from '@/app/(dashboard)/admin/candidature/page';

describe('/admin/candidature', () => {
  it('si presenta con il suo titolo e sottotitolo italiani veri', () => {
    render(<AdminCandidaturePage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(itAdminAltro.candPageTitolo);
    expect(screen.getByText(itAdminAltro.candPageSottotitolo)).toBeInTheDocument();
  });

  it('monta il pannello delle candidature', () => {
    render(<AdminCandidaturePage />);
    expect(screen.getByTestId('pannello-candidature')).toBeInTheDocument();
  });
});
