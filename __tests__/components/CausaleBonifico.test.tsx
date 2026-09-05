import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CausaleBonifico } from '@/components/features/parent/pagamenti/CausaleBonifico';

// La causale ora è COMPOSTA DAL SERVER (modello per-categoria) e passata già pronta:
// il componente la mostra soltanto. CF SINTETICI (nessuna persona reale, repo pubblico).
const voci = [
  { id: 'p1', scuola_id: 'sede-1', causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO', nome: 'Mara', cognome: 'Bianchi', hasCf: true },
  { id: 'p2', scuola_id: 'sede-1', causale: 'Iscrizione - per il minore Ugo Verdi - GIUGLIANO', nome: 'Ugo', cognome: 'Verdi', hasCf: false },
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

/**
 * `incorporata` — la stessa lista dentro un'altra card («Come pagare», E4).
 *
 * Due card annidate darebbero due bordi, due fondi bianchi e due titoli: la
 * causale è UNA sezione del bonifico, non una scheda a sé. La prop toglie il
 * guscio e l'occhiello, e NIENT'ALTRO: la lista e le sue conferme di copia
 * restano quelle di sempre — motivo per cui i test qui sopra non si toccano.
 */
describe('CausaleBonifico — variante incorporata (E4)', () => {
  it('senza la prop resta la card di oggi: guscio + occhiello', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const radice = container.firstElementChild as HTMLElement;
    expect(radice.className).toContain('rounded-card');
    expect(radice.className).toContain('border-kidville-line');
    expect(radice.className).toContain('bg-kidville-white');
    expect(screen.getByText('Causale consigliata per il bonifico')).toBeInTheDocument();
  });

  it('con `incorporata` sparisce il guscio esterno e l’occhiello, resta la lista', () => {
    const { container } = render(<CausaleBonifico voci={voci} incorporata />);
    const radice = container.firstElementChild as HTMLElement;
    expect(radice.className).not.toContain('rounded-card');
    expect(radice.className).not.toContain('border-kidville-line');
    expect(radice.className).not.toContain('bg-kidville-white');
    expect(screen.queryByText('Causale consigliata per il bonifico')).toBeNull();
    // L'intro e le causali restano: è ciò che il genitore deve copiare.
    expect(screen.getByText(/Copia la causale della voce/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Copia la causale/ })).toHaveLength(2);
    expect(screen.getByText(voci[0].causale)).toBeInTheDocument();
  });
});
