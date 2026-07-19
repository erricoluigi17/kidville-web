import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CausaleBonifico } from '@/components/features/parent/pagamenti/CausaleBonifico';

// Codici fiscali SINTETICI (nessuna persona reale): repo pubblico, niente PII di minori.
const voci = [
  { id: 'p1', descrizione: 'Retta Settembre 2026', nome: 'Mara', cognome: 'Bianchi', codiceFiscale: 'ABCDEF00A00A000A', sede: 'Kidville Giugliano' },
  { id: 'p2', descrizione: 'Iscrizione', nome: 'Ugo', cognome: 'Verdi', codiceFiscale: null, sede: 'Kidville Giugliano' },
];

describe('CausaleBonifico — formato completo + a11y (A4·A5)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('mostra la causale completa per voce: «{descrizione} - per il minore {Nome Cognome} - {CF} - {SEDE}»', () => {
    render(<CausaleBonifico voci={voci} />);
    expect(screen.getByText('Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO')).toBeInTheDocument();
    // voce senza CF: lo omette ma la causale resta utile (descrizione + minore + sede)
    expect(screen.getByText('Iscrizione - per il minore Ugo Verdi - GIUGLIANO')).toBeInTheDocument();
  });

  it('A5: il CTA «Copia» è bianco su verde (AA), non giallo-su-verde — uno per voce', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    expect(screen.getAllByRole('button', { name: /Copia la causale/ }).length).toBe(2);
    const html = container.innerHTML;
    expect(html).toContain('bg-kidville-green');
    expect(html).toContain('text-kidville-white');
    expect(html).not.toContain('text-kidville-yellow');
  });

  it('A4: i testi informativi non usano `muted` (sotto AA) ma `sub`', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const html = container.innerHTML;
    expect(screen.getByText(/Copia la causale della voce/)).toBeInTheDocument();
    expect(screen.getByText(/Codice fiscale non disponibile/)).toBeInTheDocument();
    expect(html).not.toContain('text-kidville-muted');
    expect(html).toContain('text-kidville-sub');
  });
});
