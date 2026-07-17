import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { StudentTable } from '@/components/features/admin/StudentTable';

/**
 * Step 6 — StudentTable dual render (segreteria responsive mobile).
 *
 * Sotto `sm` la tabella (che vive in un wrapper `hidden sm:block`) cede il posto
 * a una lista di `StudentRowCard` (`sm:hidden`, marker `.kv-admin-rowcard`): stessi
 * dati della riga, checkbox di selezione, tap sulla card → dettaglio. Nessuna
 * logica dati nuova. Le fixture sono FINTE (mai PII reale di minori/famiglie).
 */

// Alunni finti: cognomi/nomi inventati, niente PII reale.
const FIXTURE_CHILD = [
    {
        id: 's1',
        cognome: 'Verdi',
        nome: 'Anna',
        data_nascita: '2019-03-15',
        classe_sezione: 'Girasoli',
        stato: 'iscritto',
        note_mediche: 'Arachidi',
        bes: true,
    },
    {
        id: 's2',
        cognome: 'Bianchi',
        nome: 'Marco',
        data_nascita: '2020-06-01',
        classe_sezione: 'Margherite',
        stato: 'sospeso',
    },
];

function renderTable(props: Partial<React.ComponentProps<typeof StudentTable>> = {}) {
    const onToggleSelect = vi.fn();
    const onToggleSelectAll = vi.fn();
    const onStudentClick = vi.fn();
    const utils = render(
        <StudentTable
            students={FIXTURE_CHILD}
            selectedIds={new Set<string>()}
            onToggleSelect={onToggleSelect}
            onToggleSelectAll={onToggleSelectAll}
            onStudentClick={onStudentClick}
            currentTypeFilter="child"
            {...props}
        />,
    );
    return { ...utils, onToggleSelect, onToggleSelectAll, onStudentClick };
}

describe('StudentTable — dual render (tabella ≥sm, card <sm)', () => {
    it('rende SIA la tabella (wrapper hidden sm:block) SIA la lista di card (sm:hidden)', () => {
        const { container } = renderTable();

        // Tabella: wrapper solo-desktop con la <table> dentro.
        const tableWrap = container.querySelector('.kv-table-scroll');
        expect(tableWrap).not.toBeNull();
        expect(tableWrap!.className).toContain('sm:block');
        expect(tableWrap!.className).toContain('hidden');
        expect(tableWrap!.querySelector('table')).not.toBeNull();

        // Lista card: wrapper solo-mobile con una card per studente.
        const cardWrap = container.querySelector('[data-testid="student-cards-mobile"]');
        expect(cardWrap).not.toBeNull();
        expect(cardWrap!.className).toContain('sm:hidden');
        expect(container.querySelectorAll('.kv-admin-rowcard')).toHaveLength(2);
    });

    it('ogni dato della riga compare anche nella card corrispondente', () => {
        const { container } = renderTable();
        const cardS1 = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]');
        expect(cardS1).not.toBeNull();
        const testo = cardS1!.textContent || '';

        expect(testo).toContain('Verdi'); // cognome
        expect(testo).toContain('Anna'); // nome
        expect(testo).toContain('Girasoli'); // classe/sezione
        expect(testo).toContain('iscritto'); // stato
        expect(testo).toContain('Allergie'); // indicatore note mediche
        expect(testo).toContain('BES'); // indicatore BES
        // Data di nascita formattata come nella riga.
        const dataAttesa = new Date('2019-03-15').toLocaleDateString('it-IT', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
        });
        expect(testo).toContain(dataAttesa);
    });

    it('tap sulla card chiama onStudentClick con lo studente giusto', () => {
        const { container, onStudentClick } = renderTable();
        const cardS2 = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s2"]');
        fireEvent.click(cardS2!);
        expect(onStudentClick).toHaveBeenCalledTimes(1);
        expect(onStudentClick.mock.calls[0][0]).toMatchObject({ id: 's2', cognome: 'Bianchi' });
    });

    it('la checkbox della card chiama onToggleSelect e non propaga al click sulla card', () => {
        const { container, onToggleSelect, onStudentClick } = renderTable();
        const cardS1 = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]');
        const checkbox = cardS1!.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(checkbox).not.toBeNull();
        fireEvent.click(checkbox!);
        expect(onToggleSelect).toHaveBeenCalledWith('s1');
        expect(onStudentClick).not.toHaveBeenCalled();
    });

    it('il badge di stato «iscritto» usa il token success-strong (contrasto AA, C5)', () => {
        const { container } = renderTable();
        // Card mobile (StudentRowCard).
        const cardS1 = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]');
        const cardBadge = Array.from(cardS1!.querySelectorAll('span')).find((s) => s.textContent === 'iscritto');
        expect(cardBadge?.className).toContain('text-kidville-success-strong');
        // Tabella desktop (StudentTable): stesso token, parità tra breakpoint.
        const table = container.querySelector('table');
        const tableBadge = Array.from(table!.querySelectorAll('span')).find((s) => s.textContent === 'iscritto');
        expect(tableBadge?.className).toContain('text-kidville-success-strong');
    });

    it('l\'indicatore allergie della card NON espone la nota medica grezza nel title (privacy)', () => {
        const { container } = renderTable();
        const cardS1 = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]');
        const allergie = Array.from(cardS1!.querySelectorAll('span')).find((s) => s.textContent?.includes('Allergie'));
        const title = allergie?.getAttribute('title') ?? '';
        // Fixture s1.note_mediche = 'Arachidi': non deve finire in un attributo DOM.
        expect(title).not.toContain('Arachidi');
        expect(title).toBe('Allergie/note mediche presenti');
    });

    it('per lo staff la card mostra email/ruolo/sede e non ha checkbox', () => {
        const { container } = renderTable({
            currentTypeFilter: 'staff',
            students: [
                {
                    id: 'u1',
                    cognome: 'Rossi',
                    nome: 'Giulia',
                    ruolo: 'docente',
                    sede_nome: 'Plesso Demo',
                    classi_count: 3,
                    emails: ['finta.docente@example.test'],
                },
            ],
        });
        const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="u1"]');
        expect(card).not.toBeNull();
        const testo = card!.textContent || '';
        expect(testo).toContain('Rossi');
        expect(testo).toContain('finta.docente@example.test');
        expect(testo).toContain('Plesso Demo');
        // Lo staff non ha selezione massiva → niente checkbox nella card.
        expect(card!.querySelector('input[type="checkbox"]')).toBeNull();
    });
});
