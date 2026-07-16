import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StudentTable } from '@/components/features/admin/StudentTable';

/**
 * Guardia di design dell'anagrafica (Step W2 del re-skin segreteria).
 *
 * Lo stato vuoto della tabella alunni passa allo stile dell'app (cerchio crema +
 * emoji + testo, come `parent/avvisi/page.tsx`). Il testo esatto asserito dagli
 * e2e admin (`admin-students.spec.ts`: «Nessun alunno trovato») e la struttura
 * `tbody`/`tr` (riga 19 dello spec) NON devono cambiare.
 */

const noop = () => {};

function renderTable(students: Parameters<typeof StudentTable>[0]['students'], filter: 'child' | 'adult' | 'staff' = 'child') {
  return render(
    <StudentTable
      students={students}
      selectedIds={new Set<string>()}
      onToggleSelect={noop}
      onToggleSelectAll={noop}
      onStudentClick={vi.fn()}
      currentTypeFilter={filter}
    />,
  );
}

describe('StudentTable — stato vuoto stile app', () => {
  it('alunni: mostra il testo e2e «Nessun alunno trovato» in un cerchio crema', () => {
    const { container } = renderTable([], 'child');
    expect(screen.getByText('Nessun alunno trovato')).toBeInTheDocument();
    // Cerchio crema dell'empty-state app (segnale del re-skin, non presente prima).
    expect(container.querySelector('.bg-kidville-cream.rounded-full')).not.toBeNull();
  });

  it('staff: mostra «Nessun membro dello staff trovato»', () => {
    renderTable([], 'staff');
    expect(screen.getByText('Nessun membro dello staff trovato')).toBeInTheDocument();
  });

  it('la card usa il token bg-kidville-white (non il bianco nudo di Tailwind)', () => {
    const { container } = renderTable([], 'child');
    expect(container.querySelector('.bg-kidville-white')).not.toBeNull();
    expect(container.querySelector('.bg-white')).toBeNull();
  });
});

describe('StudentTable — struttura tabella (contratto e2e tbody/tr)', () => {
  it('rende le righe alunno dentro un <tbody>', () => {
    const { container } = renderTable(
      [{ id: 'a1', cognome: 'Arcobaleno', nome: 'Aurora', stato: 'iscritto', classe_sezione: 'Girasoli' }],
      'child',
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    // Header di gruppo per sezione preservato.
    expect(screen.getByText(/Sezione: Girasoli/)).toBeInTheDocument();
  });

  it('genitori: intestazione di gruppo «Anagrafica Generale» invariata', () => {
    renderTable([{ id: 'p1', first_name: 'Mario', last_name: 'Rossi' }], 'adult');
    expect(screen.getByText(/Anagrafica Generale/)).toBeInTheDocument();
  });
});
