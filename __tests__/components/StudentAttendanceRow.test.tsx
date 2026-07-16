import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StudentAttendanceRow, type AttendanceRecord } from '@/components/features/teacher/StudentAttendanceRow';

describe('StudentAttendanceRow', () => {
  const mockStudent = { id: '1', firstName: 'Mario', lastName: 'Rossi' };

  const presenteRecord: AttendanceRecord = {
    id: 'log1',
    alunno_id: '1',
    data: '2026-05-03',
    stato: 'presente',
    orario_entrata: '2026-05-03T08:00:00Z',
    orario_uscita: null,
  };

  it('renders student name and initial stato buttons', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Presente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ritardo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assente' })).toBeInTheDocument();
  });

  it('senza stato impostato, i 3 bottoni hanno tutti aria-pressed=false', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Presente' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Ritardo' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Assente' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onSetStato when the Presente button is clicked', () => {
    const handleSetStato = vi.fn();
    render(
      <StudentAttendanceRow
        student={mockStudent}
        onSetStato={handleSetStato}
        onCheckoutClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Presente' }));
    expect(handleSetStato).toHaveBeenCalledWith('1', 'presente');
  });

  it('mantiene i 3 bottoni di stato visibili anche con uno stato impostato', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={presenteRecord}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );
    // I bottoni non spariscono dopo la selezione: la rettifica è sempre possibile.
    expect(screen.getByRole('button', { name: 'Presente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ritardo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assente' })).toBeInTheDocument();
  });

  it('evidenzia lo stato attivo con aria-pressed=true e gli altri con false', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={presenteRecord}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Presente' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ritardo' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Assente' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('il click sullo stato già attivo NON chiama onSetStato (nessuna mutazione ridondante)', () => {
    const handleSetStato = vi.fn();
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={presenteRecord}
        onSetStato={handleSetStato}
        onCheckoutClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Presente' }));
    expect(handleSetStato).not.toHaveBeenCalled();
  });

  it('il click su uno stato diverso rettifica: chiama onSetStato col valore giusto (presente→assente)', () => {
    const handleSetStato = vi.fn();
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={presenteRecord}
        onSetStato={handleSetStato}
        onCheckoutClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Assente' }));
    expect(handleSetStato).toHaveBeenCalledWith('1', 'assente');
  });

  it('shows check-out button only when student is present and not checked out', () => {
    const handleCheckout = vi.fn();

    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={presenteRecord}
        onSetStato={vi.fn()}
        onCheckoutClick={handleCheckout}
      />
    );

    const checkoutBtn = screen.getByText('Uscita');
    expect(checkoutBtn).toBeInTheDocument();

    fireEvent.click(checkoutBtn);
    expect(handleCheckout).toHaveBeenCalledWith('1');
  });

  it('hides check-out button when the student already checked out', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={{ ...presenteRecord, orario_uscita: '2026-05-03T16:00:00Z' }}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );

    expect(screen.queryByText('Uscita')).not.toBeInTheDocument();
  });

  it('mostra il badge informativo quando lo stato è uscita anticipata, accanto ai 3 bottoni', () => {
    render(
      <StudentAttendanceRow
        student={mockStudent}
        record={{ ...presenteRecord, stato: 'uscita_anticipata', orario_uscita: '2026-05-03T13:00:00Z' }}
        onSetStato={vi.fn()}
        onCheckoutClick={vi.fn()}
      />
    );
    // I 3 bottoni restano; il badge "Uscita Ant." resta visibile come info.
    expect(screen.getByRole('button', { name: 'Presente' })).toBeInTheDocument();
    expect(screen.getByText('Uscita Ant.')).toBeInTheDocument();
  });
});
