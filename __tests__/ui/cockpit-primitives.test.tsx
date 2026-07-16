import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { PageHeader, Tabs } from '@/components/ui/cockpit';
import { TAB_GIALLO_OVUNQUE } from '@/lib/ui/tab-theme';

/**
 * Lock di design delle primitive cockpit (Step 0A del re-skin segreteria).
 *
 * `PageHeader` è ora un ADAPTER su `PageHeaderCard` (stessa card di
 * genitore/docente): stessa firma pubblica, ma delega il rendering così le ~28
 * pagine admin cambiano pelle da un solo punto. I tre invarianti che le e2e
 * admin dipendono da qui — l'`<h1>` porta ESATTAMENTE il titolo passato, la
 * eyebrow ha un default, lo slot azioni resta renderizzato — sono verificati
 * sotto. `Tabs` è passata da sottolineate a pillole con stato attivo
 * accessibile (`aria-pressed`). Il Donut non deve più contenere hex letterali:
 * i colori arrivano dal mirror `@/lib/ui/chart-colors`.
 */

describe('PageHeader (adapter su PageHeaderCard)', () => {
  it('rende un <h1> col titolo passato, invariato (vincolo e2e getByRole heading)', () => {
    render(<PageHeader title="Dashboard Direzione" />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dashboard Direzione' }),
    ).toBeInTheDocument();
  });

  it('usa la eyebrow di default "Direzione & Segreteria" quando non è passata', () => {
    render(<PageHeader title="Anagrafica Generale" />);
    expect(screen.getByText('Direzione & Segreteria')).toBeInTheDocument();
  });

  it('rispetta la eyebrow esplicita quando passata (le ondate la specializzano)', () => {
    render(<PageHeader title="Anagrafica Generale" eyebrow="Anagrafica" />);
    expect(screen.getByText('Anagrafica')).toBeInTheDocument();
    expect(screen.queryByText('Direzione & Segreteria')).not.toBeInTheDocument();
  });

  it('rende `actions` in una riga wrappabile FUORI dalla card gialla (fix ciclo 2)', () => {
    const { container } = render(
      <PageHeader title="Anagrafica Generale" actions={<button type="button">Nuova famiglia</button>} />,
    );
    const btn = screen.getByRole('button', { name: 'Nuova famiglia' });
    const card = container.querySelector('header');
    expect(card).not.toBeNull();
    expect(card!.contains(btn)).toBe(false);
    expect(btn.closest('div')?.className).toMatch(/flex-wrap/);
  });

  it('mostra la mascotte ANCHE con actions presenti (slot action libero, design scelto)', () => {
    const { container } = render(
      <PageHeader title="Anagrafica" actions={<button type="button">Nuovo</button>} />,
    );
    const mascotte = container.querySelector('header [aria-hidden="true"]');
    expect(Boolean(mascotte)).toBe(TAB_GIALLO_OVUNQUE);
  });
});

describe('Tabs (pillole)', () => {
  const options = [
    { id: 'iscritti', label: 'Iscritti', count: 3 },
    { id: 'archiviati', label: 'Archiviati' },
  ];

  it('chiama onChange con l\'id della tab cliccata', () => {
    const onChange = vi.fn();
    render(<Tabs value="iscritti" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Archiviati/ }));
    expect(onChange).toHaveBeenCalledWith('archiviati');
  });

  it('segnala la tab attiva in modo accessibile (aria-pressed)', () => {
    render(<Tabs value="iscritti" options={options} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Iscritti/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Archiviati/ })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('cockpit.tsx — zero hex letterali (colori dai token / dal mirror chart-colors)', () => {
  it('non contiene nessun colore hex nel sorgente', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'ui', 'cockpit.tsx'),
      'utf8',
    );
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });
});
