import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContabilitaNav, VISTE_CONTABILITA } from '@/components/features/admin/pagamenti/ContabilitaNav';

describe('ContabilitaNav', () => {
  it('espone le 9 viste attese (con «Cassa» fra «Ticket mensa» e «Causali»)', () => {
    expect(VISTE_CONTABILITA.map((v) => v.id)).toEqual([
      'scadenzario', 'transazioni', 'genera', 'solleciti', 'riconciliazione', 'fiscale', 'ticket', 'cassa', 'causali',
    ]);
  });

  it('rende le etichette delle viste', () => {
    render(<ContabilitaNav value="scadenzario" onChange={() => {}} />);
    // ogni etichetta compare almeno una volta (pills mobile + tabs desktop)
    for (const v of VISTE_CONTABILITA) {
      expect(screen.getAllByText(v.label).length).toBeGreaterThan(0);
    }
  });

  it('il click su una vista chiama onChange con l\'id', () => {
    const onChange = vi.fn();
    render(<ContabilitaNav value="scadenzario" onChange={onChange} />);
    fireEvent.click(screen.getAllByText('Fiscale')[0]);
    expect(onChange).toHaveBeenCalledWith('fiscale');
  });

  it('la vista «Cassa» è presente, cliccabile e chiama onChange con «cassa»', () => {
    const onChange = vi.fn();
    render(<ContabilitaNav value="scadenzario" onChange={onChange} />);
    const pillCassa = screen.getAllByText('Cassa');
    expect(pillCassa.length).toBeGreaterThan(0);
    fireEvent.click(pillCassa[0]);
    expect(onChange).toHaveBeenCalledWith('cassa');
  });

  it('quando la vista attiva è «cassa» il controllo è marcato aria-pressed', () => {
    render(<ContabilitaNav value="cassa" onChange={() => {}} />);
    // La pill mobile è un <button aria-pressed>: quella attiva è premuta.
    const premuti = screen
      .getAllByRole('button', { pressed: true })
      .filter((b) => b.textContent?.includes('Cassa'));
    expect(premuti.length).toBeGreaterThan(0);
  });
});
