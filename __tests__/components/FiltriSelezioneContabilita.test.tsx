import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  FiltroCategorieContabilita,
  FiltroMesiContabilita,
  FiltroAnnoContabilita,
} from '@/components/features/admin/pagamenti/FiltriSelezioneContabilita';

// =============================================================================
// Filtri a scelta multipla della contabilità: categorie e mesi (sul generico
// `SceltaMultiplaContabilita`) e select dell'anno scolastico. Controllati dal
// genitore. Testi veri dal catalogo italiano. Dati inventati, nessuna PII.
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

const OPZIONI = [
  { id: 'retta', testo: 'Retta' },
  { id: 'mensa', testo: 'Mensa' },
  { id: 'gita', testo: 'Gita — Aversa' },
];

function ConStatoCategorie({ iniziali = [] as string[], onChange = undefined as ((n: string[]) => void) | undefined }) {
  const [sel, setSel] = useState<string[]>(iniziali);
  return (
    <FiltroCategorieContabilita
      opzioni={OPZIONI}
      scelte={sel}
      onChange={(n) => {
        setSel(n);
        onChange?.(n);
      }}
    />
  );
}

const comandoCategorie = () => screen.getByRole('button', { name: /^Categorie / });
const comandoMesi = () => screen.getByRole('button', { name: /^Mesi / });

describe('FiltroCategorieContabilita', () => {
  it('riepilogo: nessuna scelta, una, più', () => {
    const { rerender } = render(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={[]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Categorie Tutte le categorie' })).toBeTruthy();
    rerender(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={['mensa']} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Categorie Mensa' })).toBeTruthy();
    rerender(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={['mensa', 'gita']} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Categorie 2 categorie' })).toBeTruthy();
  });

  it('il nome accessibile contiene «Categorie» e non è esattamente «Categoria»', () => {
    render(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={[]} onChange={() => {}} />);
    const nome = comandoCategorie().getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ');
    expect(nome).toContain('Categorie');
    expect(nome).not.toBe('Categoria');
    expect(screen.queryByLabelText('Categoria')).toBeNull();
  });

  it('commutare aggiunge e toglie l’id', () => {
    const onChange = vi.fn();
    render(<ConStatoCategorie onChange={onChange} />);
    fireEvent.click(comandoCategorie());
    fireEvent.click(screen.getByRole('button', { name: 'Mensa' }));
    expect(onChange).toHaveBeenLastCalledWith(['mensa']);
    fireEvent.click(screen.getByRole('button', { name: 'Retta' }));
    expect(onChange).toHaveBeenLastCalledWith(['mensa', 'retta']);
    fireEvent.click(screen.getByRole('button', { name: 'Mensa' }));
    expect(onChange).toHaveBeenLastCalledWith(['retta']);
  });

  it('«Tutte le categorie» azzera', () => {
    const onChange = vi.fn();
    render(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={['mensa']} onChange={onChange} />);
    fireEvent.click(comandoCategorie());
    fireEvent.click(screen.getByRole('button', { name: 'Tutte le categorie', pressed: false }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('le scelte che non corrispondono a un’opzione si ignorano', () => {
    render(<FiltroCategorieContabilita opzioni={OPZIONI} scelte={['fantasma', 'mensa']} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Categorie Mensa' })).toBeTruthy();
    fireEvent.click(comandoCategorie());
    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['Mensa']);
  });

  it('senza opzioni non disegna nulla', () => {
    const { container } = render(<FiltroCategorieContabilita opzioni={[]} scelte={[]} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('nessuna violazione axe a pannello aperto', async () => {
    const { container } = render(<ConStatoCategorie iniziali={['retta']} />);
    fireEvent.click(comandoCategorie());
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});

describe('FiltroMesiContabilita', () => {
  it('riepilogo: nessuno, uno, più', () => {
    const { rerender } = render(<FiltroMesiContabilita anno={2026} mesi={[]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mesi Tutto l’anno' })).toBeTruthy();
    rerender(<FiltroMesiContabilita anno={2026} mesi={[10]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mesi Ott 2026' })).toBeTruthy();
    rerender(<FiltroMesiContabilita anno={2026} mesi={[10, 11, 1]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mesi 3 mesi' })).toBeTruthy();
  });

  it('dodici pastiglie in ordine set→ago con anno solare corretto', () => {
    render(<FiltroMesiContabilita anno={2026} mesi={[]} onChange={() => {}} />);
    fireEvent.click(comandoMesi());
    const pannello = screen.getByRole('group', { name: 'Scegli i mesi' });
    const testi = [...pannello.querySelectorAll('fieldset button')].map((b) => b.textContent);
    expect(testi).toHaveLength(12);
    expect(testi[0]).toBe('Set 2026');
    expect(testi[3]).toBe('Dic 2026');
    expect(testi[4]).toBe('Gen 2027');
    expect(testi[11]).toBe('Ago 2027');
  });

  it('commutare usa il numero del mese; «Tutto l’anno» azzera', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FiltroMesiContabilita anno={2026} mesi={[]} onChange={onChange} />);
    fireEvent.click(comandoMesi());
    fireEvent.click(screen.getByRole('button', { name: 'Gen 2027' }));
    expect(onChange).toHaveBeenLastCalledWith([1]);
    rerender(<FiltroMesiContabilita anno={2026} mesi={[1, 10]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Gen 2027' }));
    expect(onChange).toHaveBeenLastCalledWith([10]);
    fireEvent.click(screen.getByRole('button', { name: 'Tutto l’anno', pressed: false }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('i mesi non validi si ignorano', () => {
    render(<FiltroMesiContabilita anno={2026} mesi={[13, 0, 10]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Mesi Ott 2026' })).toBeTruthy();
  });

  it('nessuna violazione axe a pannello aperto', async () => {
    const { container } = render(<FiltroMesiContabilita anno={2026} mesi={[9]} onChange={() => {}} />);
    fireEvent.click(comandoMesi());
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});

describe('FiltroAnnoContabilita', () => {
  it('mostra «A.S. 2026/2027» e chiama onChange col numero', () => {
    const onChange = vi.fn();
    render(<FiltroAnnoContabilita anno={2026} anni={[2025, 2026, 2027]} onChange={onChange} />);
    const select = screen.getByLabelText('Anno scolastico') as HTMLSelectElement;
    expect(select.value).toBe('2026');
    expect(screen.getByRole('option', { name: 'A.S. 2026/2027' })).toBeTruthy();
    fireEvent.change(select, { target: { value: '2027' } });
    expect(onChange).toHaveBeenCalledWith(2027);
  });

  it('nessuna violazione axe', async () => {
    const { container } = render(<FiltroAnnoContabilita anno={2026} anni={[2025, 2026]} onChange={() => {}} />);
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});
