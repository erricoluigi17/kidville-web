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
//
// ⚠️ AGGIORNATO IL 2026-09-07 — L'INDICATORE ERA UNO E DICEVA LA COSA SBAGLIATA.
// Fino a oggi la nota medica accendeva un badge chiamato «Allergie», e questo
// file lo pretendeva: `note_mediche` valorizzata ⇒ span «Allergie». Ma
// `note_mediche` è la casella che il modulo d'iscrizione etichetta «Note Mediche
// (BES, DSA, patologie)» — misurato in produzione, ZERO delle 41 note nomina un
// allergene, e 23 bambini finivano fra gli «allergici» senza avere un'allergia.
// I badge ora sono due, e ognuno ha il suo segnale: `ha_allergie` accende
// «Allergie», `ha_note_mediche` accende «Nota medica».
//
// Ciò che questo file sorveglia NON è cambiato, ed è la ragione per cui esiste:
// **il testo grezzo non finisce in nessun attributo del DOM, in nessuno dei due
// badge.** Le asserzioni sul `title` e sull'`outerHTML` sono quelle di prima.
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

/** Un indicatore dentro la TABELLA (non la card mobile), cercato per etichetta. */
function indicatoreTabella(container: HTMLElement, etichetta: string) {
  const table = container.querySelector('table')!;
  return Array.from(table.querySelectorAll('span')).find((s) => s.textContent?.includes(etichetta));
}

describe('StudentTable — nessun indicatore porta il testo della nota', () => {
  it('la nota medica grezza non finisce nel `title` della riga di tabella', () => {
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', note_mediche: NOTA_GREZZA },
    ]);
    const indicatore = indicatoreTabella(container, 'Nota medica');
    expect(indicatore).toBeTruthy();
    expect(indicatore!.getAttribute('title') ?? '').not.toContain(NOTA_GREZZA);
    expect(indicatore!.getAttribute('title')).toBe('Nota medica presente');
    // E nemmeno altrove nel markup della tabella.
    expect(container.querySelector('table')!.outerHTML).not.toContain(NOTA_GREZZA);
  });

  it('una nota medica NON accende più il badge «Allergie»: sono due cose', () => {
    // È il difetto: «Note Mediche (BES, DSA, patologie)» accendeva un badge che
    // diceva «Allergie», e il contatore della pagina lo contava lì.
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', ha_note_mediche: true },
    ]);
    expect(indicatoreTabella(container, 'Nota medica')).toBeTruthy();
    expect(indicatoreTabella(container, 'Allergie')).toBeUndefined();
  });

  it('con il solo booleano `ha_allergie` (la forma che la API manda ora) il badge allergie si accende', () => {
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', ha_allergie: true },
    ]);
    const indicatore = indicatoreTabella(container, 'Allergie');
    expect(indicatore).toBeTruthy();
    expect(indicatore!.getAttribute('title')).toBe('Allergie presenti');
    // Anche nella card mobile, che mostra gli stessi dati della riga.
    const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]')!;
    expect(Array.from(card.querySelectorAll('span')).some((s) => s.textContent?.includes('Allergie'))).toBe(true);
  });

  it('i due segnali insieme accendono DUE badge distinti', () => {
    const { container } = renderTable([
      { id: 's1', cognome: 'Verdi', nome: 'Anna', classe_sezione: 'Girasoli', stato: 'iscritto', ha_allergie: true, ha_note_mediche: true },
    ]);
    expect(indicatoreTabella(container, 'Allergie')).toBeTruthy();
    expect(indicatoreTabella(container, 'Nota medica')).toBeTruthy();
  });

  it('senza segnali gli indicatori restano spenti', () => {
    const { container } = renderTable([
      { id: 's2', cognome: 'Bianchi', nome: 'Marco', classe_sezione: 'Margherite', stato: 'iscritto', ha_note_mediche: false, ha_allergie: false },
    ]);
    expect(indicatoreTabella(container, 'Allergie')).toBeUndefined();
    expect(indicatoreTabella(container, 'Nota medica')).toBeUndefined();
  });
});
