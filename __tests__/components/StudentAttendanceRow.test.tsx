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
    expect(screen.getByText('Presente')).toBeInTheDocument();
    expect(screen.getByText('Ritardo')).toBeInTheDocument();
    expect(screen.getByText('Assente')).toBeInTheDocument();
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

    fireEvent.click(screen.getByText('Presente'));
    expect(handleSetStato).toHaveBeenCalledWith('1', 'presente');
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
});
