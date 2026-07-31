import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';

/**
 * W3-E · R72 — L'anagrafica mostrava la sede SOLO nella tab «Staff».
 *
 * La tab Staff ha una colonna «Sede» dal giorno in cui è nata. Le tab «Alunni» e
 * «Genitori», no: cognome, nome, data, classe, stato. Con tre plessi e sezioni
 * omonime, la Direzione multi-sede legge un elenco in cui due bambini omonimi di
 * due sedi sono indistinguibili — e da lì si aprono schede, si assegnano classi
 * e si spuntano caselle per le azioni massive.
 *
 * La colonna compare SOLO quando le sedi accessibili sono più d'una: alla
 * segreteria mono-plesso ripeterebbe la stessa parola su ogni riga.
 */

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => h.sedi(),
}));

const h = vi.hoisted(() => ({
  sedi: () => ({ sedi: [] as { id: string; nome: string }[] }),
}));

function conSedi(elenco: { id: string; nome: string }[]) {
  h.sedi = () => ({
    sedi: elenco,
    selezionate: [],
    effettive: elenco.map((s) => s.id),
    sedeCorrente: elenco.length === 1 ? elenco[0].id : null,
    reFetchKey: elenco.map((s) => s.id).join(','),
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  });
}

import { StudentTable } from '@/components/features/admin/StudentTable';

// Due bambini OMONIMI in due sedi: senza la sede sono la stessa riga due volte.
const OMONIMI = [
  { id: 's-a', cognome: 'Rossi', nome: 'Alfa', data_nascita: '2022-01-01', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_A },
  { id: 's-b', cognome: 'Rossi', nome: 'Alfa', data_nascita: '2022-01-01', classe_sezione: '2 ANNI', stato: 'iscritto', scuola_id: SEDE_B },
];

function renderTable(
  students: Parameters<typeof StudentTable>[0]['students'],
  filter: 'child' | 'adult' | 'staff' = 'child',
) {
  return render(
    <StudentTable
      students={students}
      selectedIds={new Set<string>()}
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onStudentClick={vi.fn()}
      currentTypeFilter={filter}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  conSedi([
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]);
});

describe('StudentTable — colonna «Sede» sugli alunni (≥sm)', () => {
  it('con due sedi ogni riga alunno dice il suo plesso', () => {
    const { container } = renderTable(OMONIMI, 'child');
    const righe = Array.from(container.querySelectorAll('tbody tr')).filter(
      (r) => r.querySelector('input[type="checkbox"]') !== null,
    );
    expect(righe).toHaveLength(2);
    expect(within(righe[0] as HTMLElement).getByText(NOME_SEDE_A)).toBeInTheDocument();
    expect(within(righe[1] as HTMLElement).getByText(NOME_SEDE_B)).toBeInTheDocument();
  });

  it('l\'intestazione «Sede» c\'è, e il colSpan del gruppo copre tutte le colonne', () => {
    const { container } = renderTable(OMONIMI, 'child');
    const intestazioni = Array.from(container.querySelectorAll('thead th')).map((t) => t.textContent?.trim());
    expect(intestazioni).toContain('Sede');
    // Il group-header deve coprire ESATTAMENTE le colonne, altrimenti la tabella
    // si sfalsa di una cella per ogni sezione.
    const gruppo = container.querySelector('tbody td[colspan]') as HTMLTableCellElement | null;
    expect(gruppo?.getAttribute('colspan')).toBe(String(intestazioni.length));
  });

  it('con UNA sola sede la colonna non compare (niente rumore per la mono-plesso)', () => {
    conSedi([{ id: SEDE_A, nome: NOME_SEDE_A }]);
    const { container } = renderTable([OMONIMI[0]], 'child');
    const intestazioni = Array.from(container.querySelectorAll('thead th')).map((t) => t.textContent?.trim());
    expect(intestazioni).not.toContain('Sede');
    expect(screen.queryByText(NOME_SEDE_A)).not.toBeInTheDocument();
  });

  it('i genitori mostrano le sedi dei FIGLI (anche più d\'una)', () => {
    const { container } = renderTable(
      [
        { id: 'p-a', last_name: 'Rossi', first_name: 'Anna', scuole_ids: [SEDE_A] },
        { id: 'p-ab', last_name: 'Verdi', first_name: 'Bruna', scuole_ids: [SEDE_A, SEDE_B] },
      ],
      'adult',
    );
    const righe = Array.from(container.querySelectorAll('tbody tr')).filter(
      (r) => r.querySelector('input[type="checkbox"]') !== null,
    );
    expect(within(righe[0] as HTMLElement).getByText(NOME_SEDE_A)).toBeInTheDocument();
    expect(within(righe[1] as HTMLElement).getByText(`${NOME_SEDE_A} · ${NOME_SEDE_B}`)).toBeInTheDocument();
  });

  it('lo staff continua a usare la sua `sede_nome`: niente doppia colonna', () => {
    const { container } = renderTable(
      [{ id: 'u1', cognome: 'Bianchi', nome: 'Ada', ruolo: 'segreteria', sede_nome: NOME_SEDE_B, classi_count: 2 }],
      'staff',
    );
    const intestazioni = Array.from(container.querySelectorAll('thead th')).map((t) => t.textContent?.trim());
    expect(intestazioni.filter((x) => x === 'Sede')).toHaveLength(1);
    // Riga tabella (≥sm) + card (<sm): due nodi, non uno di troppo in tabella.
    expect(screen.getAllByText(NOME_SEDE_B)).toHaveLength(2);
    const righe = Array.from(container.querySelectorAll('tbody tr')).filter((r) => r.querySelectorAll('td').length > 1);
    expect(within(righe[0] as HTMLElement).getAllByText(NOME_SEDE_B)).toHaveLength(1);
  });
});

describe('StudentRowCard — la lista mobile porta lo stesso dato della riga', () => {
  it('<sm: la card dell\'alunno mostra la sede', () => {
    const { container } = renderTable(OMONIMI, 'child');
    const cards = container.querySelectorAll('[data-testid="student-cards-mobile"] .kv-admin-rowcard');
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText(NOME_SEDE_A)).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText(NOME_SEDE_B)).toBeInTheDocument();
  });

  it('con una sola sede la card non la ripete', () => {
    conSedi([{ id: SEDE_A, nome: NOME_SEDE_A }]);
    const { container } = renderTable([OMONIMI[0]], 'child');
    const cards = container.querySelectorAll('[data-testid="student-cards-mobile"] .kv-admin-rowcard');
    expect(within(cards[0] as HTMLElement).queryByText(NOME_SEDE_A)).not.toBeInTheDocument();
  });
});
