import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CausaleBonifico } from '@/components/features/parent/pagamenti/CausaleBonifico';

// Codici fiscali SINTETICI (non appartengono a nessuna persona reale): il repo è
// pubblico, nei test niente PII di minori.
const figli = [
  { alunno_id: 'a1', nome: 'Mara', cognome: 'Bianchi', codiceFiscale: 'ABCDEF00A00A000A' },
  { alunno_id: 'a2', nome: 'Ugo', cognome: 'Verdi', codiceFiscale: null },
];

describe('CausaleBonifico — a11y (A4 testo informativo · A5 CTA)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('A5: il CTA «Copia» è bianco su verde (AA), non giallo-su-verde', () => {
    const { container } = render(<CausaleBonifico figli={figli} />);
    // un bottone «Copia» per figlio, con nome accessibile
    expect(screen.getAllByRole('button', { name: /Copia la causale/ }).length).toBe(2);
    const html = container.innerHTML;
    expect(html).toContain('bg-kidville-green');
    expect(html).toContain('text-kidville-white');
    expect(html).not.toContain('text-kidville-yellow');
  });

  it('A4: i testi informativi non usano `muted` (sotto AA) ma `sub`', () => {
    const { container } = render(<CausaleBonifico figli={figli} />);
    const html = container.innerHTML;
    // istruzione operativa + nota «Codice fiscale non disponibile…»: informative, ≥4.5:1
    expect(screen.getByText(/Per abbinare più in fretta/)).toBeInTheDocument();
    expect(screen.getByText(/Codice fiscale non disponibile/)).toBeInTheDocument();
    expect(html).not.toContain('text-kidville-muted');
    expect(html).toContain('text-kidville-sub');
  });
});
