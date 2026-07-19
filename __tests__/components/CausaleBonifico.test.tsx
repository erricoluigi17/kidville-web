import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CausaleBonifico } from '@/components/features/parent/pagamenti/CausaleBonifico';

// La causale ora è COMPOSTA DAL SERVER (modello per-categoria) e passata già pronta:
// il componente la mostra soltanto. CF SINTETICI (nessuna persona reale, repo pubblico).
const voci = [
  { id: 'p1', causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO', nome: 'Mara', cognome: 'Bianchi', hasCf: true },
  { id: 'p2', causale: 'Iscrizione - per il minore Ugo Verdi - GIUGLIANO', nome: 'Ugo', cognome: 'Verdi', hasCf: false },
];

describe('CausaleBonifico — formato completo + a11y (A4·A5)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('mostra la causale che arriva dal server (una per voce)', () => {
    render(<CausaleBonifico voci={voci} />);
    expect(screen.getByText('Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO')).toBeInTheDocument();
    // voce senza CF: la causale resta utile (descrizione + minore + sede)
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
