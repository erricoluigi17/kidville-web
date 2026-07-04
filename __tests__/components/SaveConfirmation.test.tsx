import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useReducedMotion } from 'framer-motion';
import { SaveCheck, SaveCelebration } from '@/components/ui/SaveConfirmation';

// Controlliamo prefers-reduced-motion mockando l'hook di framer-motion:
// deterministico e senza dipendere dalle sottigliezze di matchMedia in jsdom.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

describe('SaveConfirmation', () => {
  beforeEach(() => { vi.mocked(useReducedMotion).mockReturnValue(false); });
  afterEach(() => { vi.useRealTimers(); });

  it('SaveCheck rende una spunta accessibile', () => {
    render(<SaveCheck />);
    expect(screen.getByRole('img', { name: 'Salvato' })).toBeInTheDocument();
  });

  it('SaveCelebration mostra messaggio e coriandoli quando animata', () => {
    const { container } = render(<SaveCelebration show message="Fatto!" onDone={() => {}} />);
    expect(screen.getByText('Fatto!')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-particle]').length).toBeGreaterThan(0);
  });

  it('rispetta prefers-reduced-motion: nessun coriandolo, spunta statica', () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const { container } = render(<SaveCelebration show message="Fatto!" onDone={() => {}} />);
    expect(screen.getByText('Fatto!')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-particle]').length).toBe(0);
  });

  it('richiama onDone allo scadere del timer (auto-dismiss)', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(<SaveCelebration show durationMs={1600} onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1600); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('non mostra nulla quando show=false', () => {
    render(<SaveCelebration show={false} message="Fatto!" onDone={() => {}} />);
    expect(screen.queryByText('Fatto!')).toBeNull();
  });
});
