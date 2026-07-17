import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PagamentoCardMobile } from '@/components/features/admin/pagamenti/PagamentoCardMobile';

const base = {
  id: 'p1',
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 100,
  stato: 'parziale',
  tipo: 'singolo',
  fattura_stato: 'non_richiesta',
  scadenza: '2026-09-05',
  alunni: { nome: 'Mario', cognome: 'Rossi' },
};

describe('PagamentoCardMobile', () => {
  it('mostra alunno, descrizione, residuo e stato', () => {
    render(
      <PagamentoCardMobile
        pagamento={base}
        alunnoLabel="Mario Rossi"
        sezioneLabel="Girasoli"
        onIncassa={() => {}}
        onApri={() => {}}
      />
    );
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Retta Settembre 2026')).toBeInTheDocument();
    expect(screen.getByText(/Restano/)).toHaveTextContent('€ 50.00');
    expect(screen.getByText('Parziale')).toBeInTheDocument();
  });

  it('bottone Incassa presente se non saldato e chiama onIncassa', () => {
    const onIncassa = vi.fn();
    render(
      <PagamentoCardMobile pagamento={base} alunnoLabel="Mario Rossi" onIncassa={onIncassa} onApri={() => {}} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Incassa' }));
    expect(onIncassa).toHaveBeenCalledTimes(1);
  });

  it('"Dettagli" apre il drawer (onApri)', () => {
    const onApri = vi.fn();
    render(
      <PagamentoCardMobile pagamento={base} alunnoLabel="Mario Rossi" onIncassa={() => {}} onApri={onApri} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Dettagli/ }));
    expect(onApri).toHaveBeenCalledTimes(1);
  });

  it('se saldato niente Incassa e chip "Da fatturare"', () => {
    render(
      <PagamentoCardMobile
        pagamento={{ ...base, stato: 'pagato', importo_pagato: 150 }}
        alunnoLabel="Mario Rossi"
        onIncassa={() => {}}
        onApri={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Incassa' })).toBeNull();
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
  });

  it('la card espone il marker .kv-admin-rowcard (aggancio HC/alto contrasto)', () => {
    const { container } = render(
      <PagamentoCardMobile pagamento={base} alunnoLabel="Mario Rossi" onIncassa={() => {}} onApri={() => {}} />
    );
    expect(container.firstElementChild).toHaveClass('kv-admin-rowcard');
  });

  it('i bottoni Incassa e Dettagli hanno touch target ≥44px', () => {
    render(
      <PagamentoCardMobile pagamento={base} alunnoLabel="Mario Rossi" onIncassa={() => {}} onApri={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Incassa' })).toHaveClass('min-h-[44px]');
    expect(screen.getByRole('button', { name: /Dettagli/ })).toHaveClass('min-h-[44px]');
  });
});
