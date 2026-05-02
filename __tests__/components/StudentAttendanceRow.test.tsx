import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StudentAttendanceRow } from '@/components/features/teacher/StudentAttendanceRow';

describe('StudentAttendanceRow', () => {
  const mockStudent = { id: '1', firstName: 'Mario', lastName: 'Rossi' };

  it('renders student name correctly', () => {
    render(
      <StudentAttendanceRow 
        student={mockStudent} 
        onTogglePresence={vi.fn()} 
        onCheckoutClick={vi.fn()} 
      />
    );
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Segna Presente')).toBeInTheDocument();
  });

  it('calls onTogglePresence when the present button is clicked', () => {
    const handleToggle = vi.fn();
    render(
      <StudentAttendanceRow 
        student={mockStudent} 
        onTogglePresence={handleToggle} 
        onCheckoutClick={vi.fn()} 
      />
    );

    fireEvent.click(screen.getByText('Segna Presente'));
    expect(handleToggle).toHaveBeenCalledWith('1', true);
  });

  it('shows check-out button only when student is present and not checked out', () => {
    const mockLog = {
      id: 'log1',
      alunno_id: '1',
      data: '2026-05-03',
      orario_entrata: '2026-05-03T08:00:00Z',
      orario_uscita: null,
      stato: 'presente' as const,
      panic_alert: false,
      sync_status: 'synced' as const,
      aggiornato_il: '2026-05-03T08:00:00Z',
    };

    const handleCheckout = vi.fn();

    render(
      <StudentAttendanceRow 
        student={mockStudent} 
        attendanceLog={mockLog}
        onTogglePresence={vi.fn()} 
        onCheckoutClick={handleCheckout} 
      />
    );

    const checkoutBtn = screen.getByText('Uscita');
    expect(checkoutBtn).toBeInTheDocument();
    
    fireEvent.click(checkoutBtn);
    expect(handleCheckout).toHaveBeenCalledWith('1');
  });
});
