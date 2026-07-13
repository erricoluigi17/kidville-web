import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EventTypeButton } from '@/components/features/teacher/diary/EventTypeButton';
import { EVENT_CONFIG } from '@/components/features/teacher/diary/eventConfig';

describe('EventTypeButton', () => {
  it('renderizza emoji e label di "merenda" da EVENT_CONFIG', () => {
    render(<EventTypeButton type="merenda" onClick={vi.fn()} />);
    expect(screen.getByText(EVENT_CONFIG.merenda.emoji)).toBeInTheDocument();
    expect(screen.getByText(EVENT_CONFIG.merenda.label)).toBeInTheDocument();
  });

  it('ha nome accessibile "Registra Merenda" — contratto usato da e2e/teacher-diary.spec.ts', () => {
    render(<EventTypeButton type="merenda" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Registra Merenda' })).toBeInTheDocument();
  });

  it('al click chiama onClick con il tipo "merenda"', () => {
    const handleClick = vi.fn();
    render(<EventTypeButton type="merenda" onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Registra Merenda' }));
    expect(handleClick).toHaveBeenCalledWith('merenda');
  });

  it('renderizza emoji, label e nome accessibile di "nanna_inizio"', () => {
    render(<EventTypeButton type="nanna_inizio" onClick={vi.fn()} />);
    expect(screen.getByText(EVENT_CONFIG.nanna_inizio.emoji)).toBeInTheDocument();
    expect(screen.getByText(EVENT_CONFIG.nanna_inizio.label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registra Nanna' })).toBeInTheDocument();
  });

  it('al click chiama onClick con il tipo "nanna_inizio"', () => {
    const handleClick = vi.fn();
    render(<EventTypeButton type="nanna_inizio" onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Registra Nanna' }));
    expect(handleClick).toHaveBeenCalledWith('nanna_inizio');
  });

  it('selezionato: aria-pressed="true" annuncia lo stato agli screen reader', () => {
    render(<EventTypeButton type="merenda" selected onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Registra Merenda' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('non selezionato (default): aria-pressed="false"', () => {
    render(<EventTypeButton type="merenda" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Registra Merenda' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('disabilitato: non chiama onClick al click', () => {
    const handleClick = vi.fn();
    render(<EventTypeButton type="merenda" disabled onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Registra Merenda' }));
    expect(handleClick).not.toHaveBeenCalled();
  });
});
