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
    expect(screen.getByRole('button', { name: /Registra € 50\.00/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: /Registra € 20\.00/ })).toBeInTheDocument();
  });
});
