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
    // Valuta in it-IT: virgola decimale. Questa asserzione diceva «€ 50.00» e
    // certificava il difetto: la card mostrava il formato anglosassone alla
    // Segreteria mentre il resto dell'app (Cassa, genitore) diceva «€ 50,00».
    expect(screen.getByText(/Restano/)).toHaveTextContent('€ 50,00');
    expect(screen.getByText('Parziale')).toBeInTheDocument();
  });

  it('gli importi a quattro cifre raggruppano le migliaia col punto (it-IT)', () => {
    // 1234,50 è il caso che `formatEuro` esiste per servire: l'it-IT ha
    // minimumGroupingDigits=2 e senza `useGrouping` esplicito stamperebbe
    // «1234,50». A mano usciva «€ 1234.50»: né virgola né raggruppamento.
    render(
      <PagamentoCardMobile
        pagamento={{ ...base, importo: 1234.5, importo_pagato: 234.5, stato: 'parziale' }}
        alunnoLabel="Mario Rossi"
        onIncassa={() => {}}
        onApri={() => {}}
      />
    );
    expect(screen.getByText(/Totale/)).toHaveTextContent('Totale € 1.234,50');
    expect(screen.getByText(/Totale/)).toHaveTextContent('Pagato € 234,50');
    expect(screen.getByText(/Restano/)).toHaveTextContent('€ 1.000,00');
    // nessun residuo di formato anglosassone in tutta la card
    expect(document.body.textContent).not.toMatch(/\d\.\d{2}(?!\d)/);
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

  it('saldato con una voce attiva in coda → chip «In coda» (consegna 2a coda fatture, rilievo e)', () => {
    render(
      <PagamentoCardMobile
        pagamento={{ ...base, stato: 'pagato', importo_pagato: 150, coda_stato: 'in_coda' }}
        alunnoLabel="Mario Rossi"
        onIncassa={() => {}}
        onApri={() => {}}
      />
    );
    expect(screen.getByTestId('coda-chip')).toHaveTextContent('In coda');
  });

  it('con due chip (Da fatturare + Errore in coda) la riga chip/bottoni va a capo invece di traboccare', () => {
    // jsdom non misura: si blocca la CLASSE, e il perché sta qui. Il Badge è
    // `whitespace-nowrap` e FatturaChip ora rende due Badge. Misurato in Chrome
    // (replica fedele, font della build): senza `flex-wrap` «Dettagli» esce dalla
    // card di 27 px a 360 px e di 12 px a 375 px. È lo stato che chiede di agire,
    // e sotto `lg` la card è l'unica vista (rette, per categoria, agenda).
    render(
      <PagamentoCardMobile
        pagamento={{ ...base, stato: 'pagato', importo_pagato: 150, coda_stato: 'errore' }}
        alunnoLabel="Mario Rossi"
        onIncassa={() => {}}
        onApri={() => {}}
      />
    );
    const riga = screen.getByTestId('coda-chip').parentElement!;
    expect(riga).toContainElement(screen.getByRole('button', { name: /Dettagli/ }));
    expect(riga).toHaveClass('flex', 'flex-wrap');
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
