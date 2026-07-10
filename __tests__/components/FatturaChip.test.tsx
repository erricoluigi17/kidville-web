import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FatturaChip } from '@/components/features/admin/pagamenti/FatturaChip';

describe('FatturaChip', () => {
  it('non rende nulla se il pagamento non è saldato e non c\'è fattura in corso', () => {
    const { container } = render(<FatturaChip stato="da_pagare" fatturaStato="non_richiesta" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pagato senza fattura → "Da fatturare"', () => {
    render(<FatturaChip stato="pagato" fatturaStato="non_richiesta" />);
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
  });

  it('pagato senza fattura_stato (undefined) → "Da fatturare"', () => {
    render(<FatturaChip stato="pagato" />);
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
  });

  it('in_attesa → "In attesa SDI" anche a prescindere dallo stato', () => {
    render(<FatturaChip stato="pagato" fatturaStato="in_attesa" />);
    expect(screen.getByText('In attesa SDI')).toBeInTheDocument();
  });

  it('emessa → "Fatturata"', () => {
    render(<FatturaChip stato="pagato" fatturaStato="emessa" />);
    expect(screen.getByText('Fatturata')).toBeInTheDocument();
  });

  it('scartata → "Scartata"', () => {
    render(<FatturaChip stato="pagato" fatturaStato="scartata" />);
    expect(screen.getByText('Scartata')).toBeInTheDocument();
  });
});
