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

/**
 * La voce ATTIVA della coda fatture sulla riga (2026-09-23, consegna 2a della coda
 * fatture, rilievo e). Il chip della coda si AGGIUNGE a quello di fatturazione, non lo
 * sostituisce: finché Aruba non ha risposto il pagamento resta «Da fatturare».
 */
describe('FatturaChip — la voce in coda', () => {
  it('in_coda → «Da fatturare» E il chip blu «In coda»', () => {
    render(<FatturaChip stato="pagato" fatturaStato="non_richiesta" codaStato="in_coda" />);
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
    const chip = screen.getByTestId('coda-chip');
    expect(chip).toHaveTextContent('In coda');
    expect(chip).toHaveClass('text-kidville-info-strong');
  });

  it('in_invio → «In invio»', () => {
    render(<FatturaChip stato="pagato" fatturaStato="non_richiesta" codaStato="in_invio" />);
    expect(screen.getByTestId('coda-chip')).toHaveTextContent('In invio');
  });

  it('errore → «Errore in coda», rosso: è l’unico dei tre che chiede di agire', () => {
    render(<FatturaChip stato="pagato" fatturaStato="non_richiesta" codaStato="errore" />);
    const chip = screen.getByTestId('coda-chip');
    expect(chip).toHaveTextContent('Errore in coda');
    expect(chip).toHaveClass('text-kidville-error-strong');
  });

  it('codaStato null → c’è «Da fatturare», il chip della coda no', () => {
    render(<FatturaChip stato="pagato" fatturaStato="non_richiesta" codaStato={null} />);
    // l'assenza DOPO la presenza (.claude/rules/test.md, punto 3)
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
    expect(screen.queryByTestId('coda-chip')).toBeNull();
  });
});
