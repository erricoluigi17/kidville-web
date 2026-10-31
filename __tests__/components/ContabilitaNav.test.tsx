import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContabilitaNav, VISTE_CONTABILITA } from '@/components/features/admin/pagamenti/ContabilitaNav';

describe('ContabilitaNav', () => {
  it('espone le 13 viste attese, con Quote dal CRM dopo Riconciliazione e Uscite e Riepilogo dopo Cassa', () => {
    expect(VISTE_CONTABILITA.map((v) => v.id)).toEqual([
      'scadenzario', 'transazioni', 'genera', 'servizi', 'solleciti', 'riconciliazione', 'quote', 'fiscale', 'ticket', 'cassa', 'uscite', 'riepilogo', 'causali',
    ]);
  });

  it('ha la vista quote: «Quote dal CRM», cliccabile, chiama onChange con «quote»', () => {
    const quote = VISTE_CONTABILITA.find((v) => v.id === 'quote');
    expect(quote?.label).toBe('Quote dal CRM');
    const onChange = vi.fn();
    render(<ContabilitaNav value="scadenzario" onChange={onChange} />);
    fireEvent.click(screen.getAllByText('Quote dal CRM')[0]);
    expect(onChange).toHaveBeenCalledWith('quote');
  });

  it('quando la vista attiva è «quote» il controllo è marcato aria-pressed', () => {
    render(<ContabilitaNav value="quote" onChange={() => {}} />);
    const premuti = screen
      .getAllByRole('button', { pressed: true })
      .filter((b) => b.textContent?.includes('Quote dal CRM'));
    expect(premuti.length).toBeGreaterThan(0);
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

  it('la vista «Servizi» è presente, cliccabile e chiama onChange con «servizi»', () => {
    const onChange = vi.fn();
    render(<ContabilitaNav value="scadenzario" onChange={onChange} />);
    fireEvent.click(screen.getAllByText('Servizi')[0]);
    expect(onChange).toHaveBeenCalledWith('servizi');
  });
});
