import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  SceltaMultiplaContabilita,
  type GruppoSceltaMultipla,
  type SceltaMultiplaContabilitaProps,
} from '@/components/features/admin/pagamenti/SceltaMultiplaContabilita';

// =============================================================================
// `SceltaMultiplaContabilita` — la parte generica del filtro a scelta multipla
// (estratta da `FiltroClassiContabilita`, il cui test ne blocca il DOM).
// Qui si difende il contratto del generico: tutti i testi arrivano dal chiamante,
// disclosure accessibile, pastiglia «tutte», commutazione per id, Escape.
// Dati inventati, nessuna PII (il repo è pubblico).
// =============================================================================

expect.extend(toHaveNoViolations);

const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
};

const GRUPPI: GruppoSceltaMultipla[] = [
  {
    chiave: 'g1',
    titolo: 'Primo gruppo',
    voci: [
      { id: 'uno', testo: 'Uno' },
      { id: 'due', testo: 'Due', nomeAccessibile: 'Due — dettaglio' },
    ],
  },
  { chiave: 'g2', voci: [{ id: 'tre', testo: 'Tre' }] },
];

function monta(over: Partial<SceltaMultiplaContabilitaProps> = {}) {
  const onCommuta = vi.fn();
  const onTutte = vi.fn();
  const utente = render(
    <SceltaMultiplaContabilita
      etichetta="Voce"
      riepilogo="Tutte le voci"
      testoTutte="Tutte le voci"
      tutteAttiva
      etichettaPannello="Scegli le voci"
      legendaPredefinita="Voci"
      gruppi={GRUPPI}
      attive={new Set()}
      onCommuta={onCommuta}
      onTutte={onTutte}
      {...over}
    />,
  );
  return { ...utente, onCommuta, onTutte };
}

const comando = () => screen.getByRole('button', { name: /^Voce / });

describe('SceltaMultiplaContabilita', () => {
  it('il comando ha come nome accessibile etichetta + riepilogo', () => {
    monta({ riepilogo: '2 voci' });
    expect(screen.getByRole('button', { name: 'Voce 2 voci' })).toBeTruthy();
  });

  it('apre e chiude il pannello con aria-expanded', () => {
    monta();
    const btn = comando();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(btn.getAttribute('aria-controls')!)!.hasAttribute('hidden')).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('la pastiglia «tutte» è premuta solo con tutteAttiva e azzera col clic', () => {
    const { onTutte, rerender } = monta({ tutteAttiva: true });
    fireEvent.click(comando());
    const tutte = screen.getByRole('button', { name: 'Tutte le voci', pressed: true });
    fireEvent.click(tutte);
    expect(onTutte).toHaveBeenCalledTimes(1);

    rerender(
      <SceltaMultiplaContabilita
        etichetta="Voce"
        riepilogo="Uno"
        testoTutte="Tutte le voci"
        tutteAttiva={false}
        etichettaPannello="Scegli le voci"
        legendaPredefinita="Voci"
        gruppi={GRUPPI}
        attive={new Set(['uno'])}
        onCommuta={vi.fn()}
        onTutte={onTutte}
      />,
    );
    expect(screen.getByRole('button', { name: 'Tutte le voci', pressed: false })).toBeTruthy();
  });

  it('le voci attive sono aria-pressed e il clic chiama onCommuta con l’id', () => {
    const { onCommuta } = monta({ tutteAttiva: false, attive: new Set(['uno']) });
    fireEvent.click(comando());
    expect(screen.getByRole('button', { name: 'Uno', pressed: true })).toBeTruthy();
    // `nomeAccessibile` sostituisce il testo visibile come nome.
    const due = screen.getByRole('button', { name: 'Due — dettaglio', pressed: false });
    fireEvent.click(due);
    expect(onCommuta).toHaveBeenCalledWith('due');
    fireEvent.click(screen.getByRole('button', { name: 'Tre' }));
    expect(onCommuta).toHaveBeenLastCalledWith('tre');
  });

  it('un gruppo senza titolo prende la legenda predefinita; il pannello ha il suo nome', () => {
    monta();
    fireEvent.click(comando());
    expect(screen.getByText('Primo gruppo').tagName).toBe('LEGEND');
    expect(screen.getByText('Voci').tagName).toBe('LEGEND');
    expect(screen.getByRole('group', { name: 'Scegli le voci' })).toBeTruthy();
  });

  it('Escape chiude il pannello e riporta il fuoco al comando', () => {
    monta();
    const btn = comando();
    fireEvent.click(btn);
    screen.getByRole('button', { name: 'Uno' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });

  it('un clic fuori chiude il pannello', () => {
    monta();
    const btn = comando();
    fireEvent.click(btn);
    fireEvent.mouseDown(document.body);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('a pannello CHIUSO Escape non sposta il fuoco', () => {
    render(
      <div>
        <SceltaMultiplaContabilita
          etichetta="Voce"
          riepilogo="Tutte le voci"
          testoTutte="Tutte le voci"
          tutteAttiva
          etichettaPannello="Scegli le voci"
          legendaPredefinita="Voci"
          gruppi={GRUPPI}
          attive={new Set()}
          onCommuta={vi.fn()}
          onTutte={vi.fn()}
        />
        <button type="button">Altrove</button>
      </div>,
    );
    const btn = comando();
    fireEvent.click(btn); // apre
    fireEvent.click(btn); // chiude
    const altrove = screen.getByRole('button', { name: 'Altrove' });
    altrove.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(altrove);
  });

  it('il pannello ha `hidden` quando è chiuso', () => {
    monta();
    const btn = comando();
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(pannello.hasAttribute('hidden')).toBe(true);
    fireEvent.click(btn);
    expect(pannello.hasAttribute('hidden')).toBe(false);
  });

  it('un clic dentro il pannello non lo chiude', () => {
    monta();
    const btn = comando();
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Uno' }));
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('il fuoco che va su un elemento esterno chiude il pannello e NON torna al comando', () => {
    render(
      <div>
        <SceltaMultiplaContabilita
          etichetta="Voce"
          riepilogo="Tutte le voci"
          testoTutte="Tutte le voci"
          tutteAttiva
          etichettaPannello="Scegli le voci"
          legendaPredefinita="Voci"
          gruppi={GRUPPI}
          attive={new Set()}
          onCommuta={vi.fn()}
          onTutte={vi.fn()}
        />
        <button type="button">Altrove</button>
      </div>,
    );
    const btn = comando();
    fireEvent.click(btn);
    screen.getByRole('button', { name: 'Uno' }).focus();
    const altrove = screen.getByRole('button', { name: 'Altrove' });
    act(() => altrove.focus());
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(altrove);
  });

  it('il fuoco che si sposta DENTRO il contenitore non chiude il pannello', () => {
    monta();
    const btn = comando();
    fireEvent.click(btn);
    screen.getByRole('button', { name: 'Uno' }).focus();
    screen.getByRole('button', { name: 'Tre' }).focus();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('nessuna violazione axe a pannello aperto', async () => {
    const { container } = monta({ tutteAttiva: false, attive: new Set(['due']) });
    fireEvent.click(comando());
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});
