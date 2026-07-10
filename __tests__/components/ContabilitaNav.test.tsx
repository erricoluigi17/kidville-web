import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContabilitaNav, VISTE_CONTABILITA } from '@/components/features/admin/pagamenti/ContabilitaNav';

describe('ContabilitaNav', () => {
  it('espone le 6 viste attese', () => {
    expect(VISTE_CONTABILITA.map((v) => v.id)).toEqual([
      'scadenzario', 'genera', 'solleciti', 'riconciliazione', 'fiscale', 'ticket',
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
});
