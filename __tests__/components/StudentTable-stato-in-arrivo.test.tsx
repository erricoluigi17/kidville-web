import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import itAdmin from '../../messages/it/adminStudents.json';
import { SEDE_A } from '../fixtures/sedi';

/**
 * Lo stato «in_arrivo» si legge «In arrivo», non come il valore grezzo della colonna (4.5.15, C2).
 * Vale per la tabella e per la card dell'elenco: sono due punti diversi che stampavano `student.stato`.
 */

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: [], selezionate: [], effettive: [], sedeCorrente: null, reFetchKey: '', loading: false, toggle: vi.fn(), soloSede: vi.fn(), tutte: vi.fn() }),
}));

import { StudentTable } from '@/components/features/admin/StudentTable';
import { StudentRowCard } from '@/components/features/admin/StudentRowCard';

const ARRIVO = { id: 's-1', cognome: 'Prova', nome: 'Arrivo', data_nascita: '2023-01-01', classe_sezione: null, stato: 'in_arrivo', scuola_id: SEDE_A };

describe('lo stato «in_arrivo» a schermo', () => {
  it('la tabella dice «In arrivo», non il valore grezzo', () => {
    render(
      <StudentTable students={[ARRIVO]} selectedIds={new Set<string>()} onToggleSelect={vi.fn()} onToggleSelectAll={vi.fn()} onStudentClick={vi.fn()} currentTypeFilter="child" />,
    );
    expect(screen.getAllByText(itAdmin.statoInArrivo).length).toBeGreaterThan(0);
    expect(screen.queryByText('in_arrivo')).toBeNull();
  });

  it('la card dice «In arrivo», non il valore grezzo', () => {
    render(
      <StudentRowCard student={ARRIVO} isSelected={false} onToggleSelect={vi.fn()} onClick={vi.fn()} currentTypeFilter="child" />,
    );
    expect(screen.getByText(itAdmin.statoInArrivo)).toBeInTheDocument();
    expect(screen.queryByText('in_arrivo')).toBeNull();
  });
});
