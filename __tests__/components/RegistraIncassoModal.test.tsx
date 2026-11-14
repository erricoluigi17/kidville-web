import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegistraIncassoModal } from '@/components/features/admin/pagamenti/RegistraIncassoModal';

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const pagamento = {
  id: 'p1',
  descrizione: 'Gita allo zoo',
  importo: 150,
  importo_pagato: 100,
  stato: 'parziale',
  tipo: 'singolo',
  alunni: { nome: 'Mario', cognome: 'Rossi' },
};

describe('RegistraIncassoModal — anti-errore', () => {
  it('col metodo contanti (default) avvisa che la quota non sarà detraibile', () => {
    render(<RegistraIncassoModal pagamento={pagamento} userId="u1" onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/non sarà detraibile/i)).toBeInTheDocument();
  });

  it('passando a bonifico il warning sparisce', () => {
    render(<RegistraIncassoModal pagamento={pagamento} userId="u1" onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bonifico' } });
    expect(screen.queryByText(/non sarà detraibile/i)).toBeNull();
  });

  it('il bottone di conferma riporta l\'importo che verrà registrato', () => {
    render(<RegistraIncassoModal pagamento={pagamento} userId="u1" onClose={() => {}} onDone={() => {}} />);
    // Formato valuta it-IT (virgola decimale) via formatEuro.
    expect(screen.getByRole('button', { name: /Registra € 50,00/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: /Registra € 20,00/ })).toBeInTheDocument();
  });

  it('l\u2019avviso sui contanti è in parole semplici: niente «AdE» nel testo principale, il riferimento normativo è un dettaglio a parte', () => {
    render(<RegistraIncassoModal pagamento={pagamento} userId="u1" onClose={() => {}} onDone={() => {}} />);
    const principale = screen.getByText(/non si può detrarre nella dichiarazione dei redditi/i);
    expect(principale.firstChild?.textContent).not.toMatch(/AdE|TUIR/);
    const dettaglio = screen.getByText(/art\. 15 TUIR/);
    expect(dettaglio.textContent).not.toMatch(/\bAdE\b/);
    expect(dettaglio).not.toBe(principale);
  });
});
