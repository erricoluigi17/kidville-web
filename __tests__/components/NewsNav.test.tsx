import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewsNav, VISTE_NEWS } from '@/components/features/admin/news/NewsNav';

/**
 * Navigazione della sezione News del cockpit admin (Step 4): clone strutturale
 * di `ContabilitaNav`. Cinque viste: Elenco | Editor | Proposte | Categorie |
 * Digest. Il sync con `?vista=` vive nella pagina, qui solo value/onChange.
 */
describe('NewsNav', () => {
  it('espone le 5 viste attese', () => {
    expect(VISTE_NEWS.map((v) => v.id)).toEqual([
      'elenco', 'editor', 'proposte', 'categorie', 'digest',
    ]);
  });

  it('rende le etichette delle viste', () => {
    render(<NewsNav value="elenco" onChange={() => {}} />);
    for (const v of VISTE_NEWS) {
      expect(screen.getAllByText(v.label).length).toBeGreaterThan(0);
    }
  });

  it("il click su una vista chiama onChange con l'id", () => {
    const onChange = vi.fn();
    render(<NewsNav value="elenco" onChange={onChange} />);
    fireEvent.click(screen.getAllByText('Categorie')[0]);
    expect(onChange).toHaveBeenCalledWith('categorie');
  });

  it('quando la vista attiva è «categorie» il controllo è marcato aria-pressed', () => {
    render(<NewsNav value="categorie" onChange={() => {}} />);
    const premuti = screen
      .getAllByRole('button', { pressed: true })
      .filter((b) => b.textContent?.includes('Categorie'));
    expect(premuti.length).toBeGreaterThan(0);
  });
});
