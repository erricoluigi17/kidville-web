import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';

describe('CheckoutModal', () => {
  const mockDelegates = [
    { id: 'd1', alunno_id: '1', nome: 'Nonno Franco', relazione: 'Nonno', foto_url: null },
  ];

  it('renders delegates correctly', () => {
    render(
      <CheckoutModal 
        studentName="Mario Rossi"
        delegates={mockDelegates}
        onClose={vi.fn()}
        onConfirmCheckout={vi.fn()}
        onPanicAlert={vi.fn()}
      />
    );

    expect(screen.getByText('Uscita: Mario Rossi')).toBeInTheDocument();
    expect(screen.getByText('Nonno Franco')).toBeInTheDocument();
    expect(screen.getByText('Nonno')).toBeInTheDocument();
  });

  it('handles standard checkout confirmation', () => {
    const handleConfirm = vi.fn();
    render(
      <CheckoutModal 
        studentName="Mario Rossi"
        delegates={mockDelegates}
        onClose={vi.fn()}
        onConfirmCheckout={handleConfirm}
        onPanicAlert={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Conferma'));
    expect(handleConfirm).toHaveBeenCalledWith('d1');
  });

  it('invokes Panic Alert and shows loading state', async () => {
    // Simuliamo una promessa asincrona per testare lo stato di loading
    const handlePanic = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
    
    render(
      <CheckoutModal 
        studentName="Mario Rossi"
        delegates={mockDelegates}
        onClose={vi.fn()}
        onConfirmCheckout={vi.fn()}
        onPanicAlert={handlePanic}
      />
    );

    const panicBtn = screen.getByText(/PANIC ALERT/i);
    fireEvent.click(panicBtn);

    expect(handlePanic).toHaveBeenCalled();
    expect(screen.getByText('Invio Allarme...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/PANIC ALERT/i)).toBeInTheDocument();
    });
  });
});
