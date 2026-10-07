import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { KpiContabilita } from '@/components/features/admin/pagamenti/KpiContabilita';

// =============================================================================
// KPI della Direzione: card, tabella per sede, riga della selezione e occhio
// «Nascondi cifre». Testi veri dal catalogo italiano. Importi inventati.
// =============================================================================

vi.mock('next-intl', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { IntlMessageFormat } = await import('intl-messageformat');
  const catalogo: Record<string, unknown> = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
  );
  const t = (key: string, valori?: Record<string, unknown>) => {
    const v = catalogo[key];
    if (typeof v !== 'string') return `adminContabilita.${key}`;
    return valori === undefined ? v : String(new IntlMessageFormat(v, 'it').format(valori));
  };
  return { useTranslations: () => t, useLocale: () => 'it' };
});

expect.extend(toHaveNoViolations);

const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
};

const TOTALI = { incassato: 1234.5, daIncassare: 200, scaduto: 50, daFatturare: 80, nDaFatturare: 3 };
const SEDI = [
  { id: 's1', totali: { incassato: 600, daIncassare: 100, scaduto: 20, daFatturare: 40, nDaFatturare: 1 } },
  { id: 's2', totali: { incassato: 634.5, daIncassare: 100, scaduto: 30, daFatturare: 40, nDaFatturare: 2 } },
];

function monta(over: Partial<React.ComponentProps<typeof KpiContabilita>> = {}) {
  const onCommutaNascoste = vi.fn();
  const utente = render(
    <KpiContabilita
      totals={TOTALI}
      totaliPerSede={SEDI}
      loading={false}
      mostraSede
      nomeSedeTesto={(id) => `Sede ${id}`}
      nascoste={false}
      onCommutaNascoste={onCommutaNascoste}
      {...over}
    />,
  );
  return { ...utente, onCommutaNascoste };
}

describe('KpiContabilita', () => {
  it('mostra gli importi formattati in euro nelle card e nella tabella per sede', () => {
    monta();
    const card = screen.getByTestId('kpi-contabilita');
    expect(card.textContent).toContain('€');
    expect(within(card).getByText(/1\.234,50/)).toBeInTheDocument();
    const sede = screen.getByTestId('kpi-per-sede');
    expect(within(sede).getByText(/634,50/)).toBeInTheDocument();
    expect(within(sede).getByText('Sede s1')).toBeInTheDocument();
  });

  it('con le cifre nascoste nessun «€» nelle card e nella tabella, e compaiono le maschere', () => {
    monta({ nascoste: true });
    const card = screen.getByTestId('kpi-contabilita');
    const sede = screen.getByTestId('kpi-per-sede');
    expect(card.textContent).not.toContain('€');
    expect(sede.textContent).not.toContain('€');
    expect(within(card).getAllByText('Cifra nascosta')).toHaveLength(4);
    expect(within(sede).getAllByText('Cifra nascosta')).toHaveLength(8);
    expect(within(card).getAllByText('••••')).toHaveLength(4);
    // Il conteggio non è una cifra in euro: resta.
    expect(within(card).getByText('3 pagamenti')).toBeInTheDocument();
  });

  it('durante il caricamento le card mostrano «—» e la tabella per sede non c\'è', () => {
    monta({ loading: true });
    const card = screen.getByTestId('kpi-contabilita');
    expect(within(card).getAllByText('—')).toHaveLength(4);
    expect(screen.queryByTestId('kpi-per-sede')).toBeNull();
  });

  it('con loading e cifre nascoste resta «—», senza maschere', () => {
    monta({ loading: true, nascoste: true });
    const card = screen.getByTestId('kpi-contabilita');
    expect(within(card).getAllByText('—')).toHaveLength(4);
    expect(within(card).queryByText('Cifra nascosta')).toBeNull();
  });

  it('senza più sedi la tabella per sede non compare', () => {
    monta({ mostraSede: false });
    expect(screen.queryByTestId('kpi-per-sede')).toBeNull();
  });

  it('il bottone si chiama «Nascondi cifre» in entrambi gli stati e aria-pressed cambia', () => {
    const { rerender, onCommutaNascoste } = monta({ nascoste: false });
    const bottone = screen.getByRole('button', { name: 'Nascondi cifre' });
    expect(bottone).toHaveAttribute('aria-pressed', 'false');
    rerender(
      <KpiContabilita
        totals={TOTALI}
        totaliPerSede={SEDI}
        loading={false}
        mostraSede
        nomeSedeTesto={(id) => `Sede ${id}`}
        nascoste
        onCommutaNascoste={onCommutaNascoste}
      />,
    );
    const premuto = screen.getByRole('button', { name: 'Nascondi cifre' });
    expect(premuto).toHaveAttribute('aria-pressed', 'true');
  });

  it('il clic sul bottone chiama onCommutaNascoste', () => {
    const { onCommutaNascoste } = monta();
    fireEvent.click(screen.getByRole('button', { name: 'Nascondi cifre' }));
    expect(onCommutaNascoste).toHaveBeenCalledTimes(1);
  });

  it('il bottone è type="button" e le icone sono nascoste agli screen reader', () => {
    const { container, rerender, onCommutaNascoste } = monta({ nascoste: false });
    const bottone = screen.getByRole('button', { name: 'Nascondi cifre' });
    expect(bottone).toHaveAttribute('type', 'button');
    expect(bottone).toHaveAttribute('title', 'Nascondi cifre');
    const icona = () => bottone.querySelector('svg');
    expect(icona()).toHaveAttribute('aria-hidden', 'true');
    rerender(
      <KpiContabilita
        totals={TOTALI}
        totaliPerSede={SEDI}
        loading={false}
        mostraSede
        nomeSedeTesto={(id) => `Sede ${id}`}
        nascoste
        onCommutaNascoste={onCommutaNascoste}
      />,
    );
    expect(container.querySelector('[data-testid="kpi-selezione"] svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('con testoSelezione la frase «Somma di: …» compare, e senza testoSelezione non compare', () => {
    const { unmount } = monta({ testoSelezione: 'Retta · Ottobre' });
    expect(within(screen.getByTestId('kpi-selezione')).getByText('Somma di: Retta · Ottobre')).toBeInTheDocument();
    unmount();
    monta();
    expect(within(screen.getByTestId('kpi-selezione')).queryByText(/Somma di/)).toBeNull();
  });

  it('axe: nessuna violazione, con cifre visibili e nascoste', async () => {
    const { container, rerender, onCommutaNascoste } = monta({ testoSelezione: 'Retta' });
    expect(await axe(container, axeOpts)).toHaveNoViolations();
    rerender(
      <KpiContabilita
        totals={TOTALI}
        totaliPerSede={SEDI}
        loading={false}
        mostraSede
        nomeSedeTesto={(id) => `Sede ${id}`}
        nascoste
        onCommutaNascoste={onCommutaNascoste}
      />,
    );
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});
