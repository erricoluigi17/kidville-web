import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// =============================================================================
// W8 (coda) — L'indicatore «Allergie» della TABELLA desktop esponeva la nota
// medica grezza in un attributo `title` del DOM:
//
//     title={`${t('allergie')}: ${student.note_mediche}`}
//
// La card mobile (`StudentRowCard`) era già stata corretta e ha il suo test; la
// riga di tabella no. È lo stesso dato (art. 9 GDPR, di un minore) nella stessa
// pagina, con due comportamenti diversi: una svista, non una scelta.
//
// Dal 2026-07-31 `GET /api/admin/students` non restituisce nemmeno più il testo
// — manda il booleano `ha_note_mediche`. I due componenti devono accendere
// l'indicatore su QUEL segnale, altrimenti l'unica traccia visibile della lista
// («questo bambino ha una nota medica») sparirebbe in silenzio.
// =============================================================================

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'sede-unica', nome: 'Kidville Alfa' }],
    selezionate: [],
    effettive: ['sede-unica'],
    sedeCorrente: 'sede-unica',
    reFetchKey: 'sede-unica',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}));

import { StudentTable } from '@/components/features/admin/StudentTable';

const NOTA_GREZZA = 'NOTA-MEDICA-SENTINELLA';

function renderTable(students: Parameters<typeof StudentTable>[0]['students']) {
  return render(
    <StudentTable
      students={students}
      selectedIds={new Set<string>()}
      onToggleSelect={vi.fn()}
      onToggleSelectAll={vi.fn()}
      onStudentClick={vi.fn()}
      currentTypeFilter="child"
    />,
  );
}

/** L'indicatore «Allergie» dentro la TABELLA (non la card mobile). */
function indicatoreTabella(container: HTMLElement) {
  const table = container.querySelector('table')!;
  return Array.from(table.querySelectorAll('span')).find((s) => s.textContent?.includes('Allergie'));
}

describe('StudentTable — l\'indicatore allergie non porta il testo della nota', () => {
  it('la nota medica grezza non finisce nel `title` della riga di tabella', () => {
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', note_mediche: NOTA_GREZZA },
    ]);
    const indicatore = indicatoreTabella(container);
    expect(indicatore).toBeTruthy();
    expect(indicatore!.getAttribute('title') ?? '').not.toContain(NOTA_GREZZA);
    expect(indicatore!.getAttribute('title')).toBe('Allergie/note mediche presenti');
    // E nemmeno altrove nel markup della tabella.
    expect(container.querySelector('table')!.outerHTML).not.toContain(NOTA_GREZZA);
  });

  it('con il solo booleano `ha_note_mediche` (la forma che la API manda ora) l\'indicatore si accende', () => {
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', ha_note_mediche: true },
    ]);
    expect(indicatoreTabella(container)).toBeTruthy();
    // Anche nella card mobile, che mostra gli stessi dati della riga.
    const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]')!;
    expect(Array.from(card.querySelectorAll('span')).some((s) => s.textContent?.includes('Allergie'))).toBe(true);
  });

  it('senza nota medica l\'indicatore resta spento', () => {
    const { container } = renderTable([
      { id: 's2', cognome: 'Bianchi', nome: 'Marco', classe_sezione: 'Margherite', stato: 'iscritto', ha_note_mediche: false },
    ]);
    expect(indicatoreTabella(container)).toBeUndefined();
  });
});
