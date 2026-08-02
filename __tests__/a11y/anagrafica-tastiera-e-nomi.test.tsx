import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';

// =============================================================================
// S38 · Anagrafica alunni — la vista TABELLA torna raggiungibile da tastiera,
// e ogni casella di selezione dice DI CHI è.
//
// LA MISURA (collaudo 2026-08-02, browser vero su /admin/students):
//  · gli elementi focusabili dentro una riga di tabella erano ESATTAMENTE 1 — la
//    checkbox, che ferma il click con `stopPropagation` e quindi non apre niente.
//    Link/bottoni verso la scheda dell'alunno: 0. Nessuna delle 25 schede si
//    apriva senza mouse (WCAG 2.1.1, livello A).
//  · 26 caselle di controllo con nome accessibile VUOTO: uno screen reader
//    annuncia 26 volte «casella di controllo, non selezionata» senza dire di
//    quale bambino, e la selezione multipla (che poi assegna sezione e mensa)
//    diventa un'operazione alla cieca su dati di minori (WCAG 4.1.2).
//  · il nome della SEDE — il dato su cui ruota tutto il multi-sede — dipinto in
//    `text-kidville-muted`: #9AA6A2 su bianco = 2,51:1, contro i 4,5:1 di AA.
//
// LA CAUSA RADICE è la stessa nelle tre righe: la regola è stata applicata su UNA
// delle due strade. Il gemello mobile `StudentRowCard` ha `role="button"`,
// `tabIndex`, `onKeyDown` e `aria-label` col nome dal ciclo precedente; la
// tabella no. È il pattern che la memoria di progetto chiama «una regola valida
// per due strade deve vivere in un posto solo» — qui il posto solo non c'è, e
// allora il test tiene insieme le due strade: OGNI asserzione si ripete sulla
// riga di tabella E sulla card, così la prossima svista si vede subito.
//
// Perché un BOTTONE nella cella e non `role="button"` sul `<tr>`: una riga
// intera trasformata in bottone è un pattern ostile (il contenuto della riga
// diventa il nome del bottone, il tasto centrale e «apri in nuova scheda» non
// funzionano, e dentro ci vivono altri controlli — la checkbox). Il click sulla
// riga resta come comodità del mouse: non è lui l'accessibilità.
// =============================================================================

// ── Perché questo file rimpiazza il mock GLOBALE di next-intl ────────────────
// `test/setup.ts` mocka next-intl con `t = (key) => messaggio` — i VALORI non
// arrivano nemmeno alla funzione. Ogni stringa interpolata resta letterale:
// `aria-label="Apri scheda di {nome}"`. È il motivo per cui nessun test della
// suite poteva accorgersi che i nomi accessibili dell'anagrafica non portano il
// nome di nessuno: col mock globale sono TUTTI la stessa stringa.
// Qui si risolve contro i messaggi italiani VERI e si interpola davvero, così
// l'asserzione «la casella dice di CHI è» misura quello che sente l'utente.
vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, string>> = {
    adminStudents: (await import('../../messages/it/adminStudents.json')).default,
    etichette: (await import('../../messages/it/etichette.json')).default,
  };
  const risolvi = (ns: string | undefined, key: string): string =>
    (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key);
  /** Sottoinsieme ICU che serve all'anagrafica: `{chiave}` e il ramo `other` dei plurali. */
  const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
    modello
      .replace(/\{(\w+),\s*plural,[^]*?other\s*\{([^{}]*)\}\s*\}/g, (_m, k: string, ramo: string) =>
        ramo.replace(/#/g, String(valori[k] ?? '')),
      )
      .replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero));
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori);
    return Object.assign(t, {
      rich: t,
      markup: t,
      raw: (key: string) => risolvi(ns, key),
      has: (key: string) => Boolean(ns && cataloghi[ns] && key in cataloghi[ns]),
    });
  };
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

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

// Alunni FINTI (mai PII reale di minori). «ritirato» c'è di proposito: il suo
// badge è l'ultimo punto della tabella che dipingeva testo con `muted`.
const ALUNNI = [
  { id: 's1', cognome: 'Verdi', nome: 'Anna', data_nascita: '2019-03-15', classe_sezione: 'Girasoli', stato: 'iscritto', scuola_id: SEDE_A },
  { id: 's2', cognome: 'Bianchi', nome: 'Marco', data_nascita: '2020-06-01', classe_sezione: 'Margherite', stato: 'ritirato', scuola_id: SEDE_B },
];

const GENITORI = [
  { id: 'p1', last_name: 'Neri', first_name: 'Carla', emails: ['finta.genitrice@example.test'], scuole_ids: [SEDE_A] },
];

const STAFF = [
  { id: 'u1', cognome: 'Gialli', nome: 'Ada', ruolo: 'docente', sede_nome: NOME_SEDE_B, classi_count: 2, emails: ['finta.docente@example.test'] },
];

function renderTable(
  students: Parameters<typeof StudentTable>[0]['students'] = ALUNNI,
  filter: 'child' | 'adult' | 'staff' = 'child',
) {
  const onToggleSelect = vi.fn();
  const onToggleSelectAll = vi.fn();
  const onStudentClick = vi.fn();
  const utils = render(
    <StudentTable
      students={students}
      selectedIds={new Set<string>()}
      onToggleSelect={onToggleSelect}
      onToggleSelectAll={onToggleSelectAll}
      onStudentClick={onStudentClick}
      currentTypeFilter={filter}
    />,
  );
  return { ...utils, onToggleSelect, onToggleSelectAll, onStudentClick };
}

/** Le righe DATO della tabella (non le intestazioni di gruppo, che hanno colspan). */
function righeDato(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('tbody tr')).filter(
    (r) => r.querySelector('td[colspan]') === null,
  );
}

/**
 * La stessa sonda usata dal tester nel browser: cosa, dentro questa riga, può
 * ricevere il focus da tastiera. Prima della correzione rispondeva `1` — la sola
 * checkbox, che non apre la scheda.
 */
function focusabili(riga: HTMLElement): HTMLElement[] {
  return Array.from(
    riga.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * Il colore che VINCE su un nodo: la utility `text-kidville-*` più vicina
 * risalendo gli antenati (le utility Tailwind hanno la stessa specificità e
 * `color` si eredita → decide l'elemento più interno).
 */
function coloreTesto(el: Element | null): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = Array.from(n.classList).find((x) => /^text-kidville-[a-z-]+$/.test(x));
    if (c) return c.replace('text-kidville-', '');
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  conSedi([
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]);
});

// =============================================================================
describe('S38 · la scheda dell\'alunno si apre da TASTIERA anche dalla tabella', () => {
  it('CONTROLLO POSITIVO: il mock i18n di questo file INTERPOLA davvero', () => {
    // Senza questa verifica, il giorno in cui il mock qui sopra tornasse a
    // ignorare i valori tutte le asserzioni sui nomi accessibili diventerebbero
    // tautologie verdi: ogni etichetta sarebbe la stessa stringa con `{nome}`.
    const { container } = renderTable();
    const etichette = Array.from(container.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') ?? '');
    expect(etichette.length, 'nessuna etichetta da misurare').toBeGreaterThan(0);
    expect(etichette.filter((x) => x.includes('{'))).toEqual([]);
    expect(etichette).toContain('Apri scheda di Verdi Anna');
  });

  it('CONTROLLO POSITIVO: la sonda vede le righe dato e i loro focusabili', () => {
    const { container } = renderTable();
    const righe = righeDato(container);
    expect(righe, 'due alunni ⇒ due righe dato').toHaveLength(2);
    // Se domani la checkbox sparisse, questa riga diventerebbe rossa e il test
    // sotto non starebbe più misurando quello che crede.
    expect(righe.every((r) => r.querySelector('input[type="checkbox"]') !== null)).toBe(true);
  });

  it('ogni riga porta un comando FOCUSABILE che apre la scheda (non solo la checkbox)', () => {
    const { container, onStudentClick } = renderTable();
    for (const riga of righeDato(container)) {
      const elementi = focusabili(riga);
      // Prima della correzione: 1 (la sola checkbox). Ora almeno 2.
      expect(elementi.length, 'nella riga non c\'è nessun comando oltre alla checkbox').toBeGreaterThan(1);
      expect(elementi.some((e) => e.tagName === 'BUTTON')).toBe(true);
    }

    // Il comando è un bottone NATIVO: è la piattaforma a garantire Invio e Spazio,
    // e `type="button"` gli impedisce di inviare il form che lo racchiude.
    const primo = within(righeDato(container)[0]).getByRole('button', { name: /Verdi Anna/ });
    expect(primo.tagName).toBe('BUTTON');
    expect(primo.getAttribute('type')).toBe('button');

    fireEvent.click(primo);
    expect(onStudentClick).toHaveBeenCalledTimes(1);
    expect(onStudentClick.mock.calls[0][0]).toMatchObject({ id: 's1', cognome: 'Verdi' });
  });

  it('il nome accessibile del comando contiene il bambino, non «apri» e basta', () => {
    const { container } = renderTable();
    const riga = righeDato(container)[1];
    const bottone = within(riga).getByRole('button', { name: /Bianchi Marco/ });
    // WCAG 2.5.3 «Label in Name»: il testo VISIBILE (il cognome) deve essere
    // contenuto nel nome accessibile, altrimenti il comando vocale «clicca
    // Bianchi» non trova niente.
    expect(bottone.textContent).toContain('Bianchi');
    expect(bottone.getAttribute('aria-label')).toContain('Bianchi');
  });

  it('il click sulla riga resta per il mouse, e il bottone non lo fa scattare due volte', () => {
    const { container, onStudentClick } = renderTable();
    const riga = righeDato(container)[0];

    fireEvent.click(riga);
    expect(onStudentClick, 'la riga cliccabile è la comodità del mouse: non deve sparire').toHaveBeenCalledTimes(1);

    onStudentClick.mockClear();
    fireEvent.click(within(riga).getByRole('button', { name: /Verdi Anna/ }));
    expect(onStudentClick, 'il click del bottone risale al <tr>: la scheda si aprirebbe due volte').toHaveBeenCalledTimes(1);
  });

  it('vale anche per i GENITORI e per lo STAFF (stessa tabella, stesse tre tab)', () => {
    const genitori = renderTable(GENITORI, 'adult');
    const rigaG = righeDato(genitori.container)[0];
    fireEvent.click(within(rigaG).getByRole('button', { name: /Neri Carla/ }));
    expect(genitori.onStudentClick).toHaveBeenCalledTimes(1);
    genitori.unmount();

    const staff = renderTable(STAFF, 'staff');
    const rigaS = righeDato(staff.container)[0];
    fireEvent.click(within(rigaS).getByRole('button', { name: /Gialli Ada/ }));
    expect(staff.onStudentClick).toHaveBeenCalledTimes(1);
  });

  it('la card mobile continua ad aprirsi da tastiera (la strada già corretta non si rompe)', () => {
    const { container, onStudentClick } = renderTable();
    const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]')!;
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onStudentClick).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe('S38 · ogni casella di selezione dice DI CHI è', () => {
  it('CONTROLLO POSITIVO: le caselle ci sono tutte (2 righe + «tutti» + 2 card)', () => {
    const { container } = renderTable();
    const tabella = container.querySelector<HTMLElement>('table')!;
    expect(within(tabella).getAllByRole('checkbox')).toHaveLength(3);
    const cards = container.querySelector<HTMLElement>('[data-testid="student-cards-mobile"]')!;
    expect(within(cards).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('nessuna casella con nome accessibile VUOTO (erano 26 su /admin/students)', () => {
    const { container } = renderTable();
    const senzaNome = within(container).queryAllByRole('checkbox', { name: '' });
    expect(
      senzaNome.length,
      'casella di controllo senza nome: lo screen reader annuncia «non selezionata» e basta',
    ).toBe(0);
  });

  it('la casella della riga porta il nome del bambino, in tabella E nella card', () => {
    const { container, onToggleSelect } = renderTable();
    const riga = righeDato(container)[0];
    const inRiga = within(riga).getByRole('checkbox', { name: /Verdi Anna/ });
    fireEvent.click(inRiga);
    expect(onToggleSelect).toHaveBeenCalledWith('s1');

    const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s1"]')!;
    expect(within(card).getByRole('checkbox', { name: /Verdi Anna/ })).toBeInTheDocument();
  });

  it('la casella «seleziona tutto» dice cosa selezionerebbe', () => {
    const { container, onToggleSelectAll } = renderTable();
    const testa = container.querySelector<HTMLElement>('thead')!;
    const tutti = within(testa).getByRole('checkbox', { name: /Seleziona tutti/i });
    fireEvent.click(tutti);
    expect(onToggleSelectAll).toHaveBeenCalledTimes(1);
  });

  it('sui genitori il nome della casella parla di genitori, non di alunni', () => {
    const { container } = renderTable(GENITORI, 'adult');
    const testa = container.querySelector<HTMLElement>('thead')!;
    expect(within(testa).getByRole('checkbox', { name: /genitor/i })).toBeInTheDocument();
    const riga = righeDato(container)[0];
    expect(within(riga).getByRole('checkbox', { name: /Neri Carla/ })).toBeInTheDocument();
  });
});

// =============================================================================
describe('S38 · il nome della sede è leggibile (AA), in tabella e su card', () => {
  it('CONTROLLO POSITIVO: la sonda del colore riconosce `muted` quando c\'è', () => {
    const esterno = document.createElement('td');
    esterno.className = 'px-3 py-3 font-maven text-sm text-kidville-muted';
    const interno = document.createElement('span');
    esterno.appendChild(interno);
    expect(coloreTesto(interno)).toBe('muted');
  });

  it('la cella «Sede» della riga usa `sub` (6,46:1), non `muted` (2,51:1)', () => {
    const { container } = renderTable();
    const riga = righeDato(container)[0];
    const cella = within(riga).getByText(NOME_SEDE_A);
    expect(cella.textContent, 'la sonda sta guardando la cella della sede').toBe(NOME_SEDE_A);
    expect(coloreTesto(cella)).toBe('sub');
  });

  it('la card mobile dice la sede con lo stesso token della riga', () => {
    const { container } = renderTable();
    const card = container.querySelector<HTMLElement>('.kv-admin-rowcard[data-student-id="s2"]')!;
    expect(coloreTesto(within(card).getByText(NOME_SEDE_B))).toBe('sub');
  });

  it('in tutta l\'anagrafica non resta un solo testo dipinto con `muted`', () => {
    const { container } = renderTable();
    const colpevoli = Array.from(container.querySelectorAll('*')).filter((e) =>
      e.classList.contains('text-kidville-muted'),
    );
    expect(
      colpevoli.map((e) => `${e.tagName.toLowerCase()}: ${(e.textContent ?? '').trim().slice(0, 40)}`),
      '`muted` (#9AA6A2) è 2,51:1 su bianco e 2,27:1 su crema: non è un inchiostro',
    ).toEqual([]);
  });

  it('lo stesso vale sulle tab Genitori e Staff', () => {
    const CASI: { dati: Parameters<typeof StudentTable>[0]['students']; filtro: 'adult' | 'staff' }[] = [
      { dati: GENITORI, filtro: 'adult' },
      { dati: STAFF, filtro: 'staff' },
    ];
    for (const { dati, filtro } of CASI) {
      const { container, unmount } = renderTable(dati, filtro);
      const colpevoli = Array.from(container.querySelectorAll('*')).filter((e) =>
        e.classList.contains('text-kidville-muted'),
      );
      expect(colpevoli.map((e) => e.tagName), `tab ${filtro}`).toEqual([]);
      unmount();
    }
  });

  it('il contorno delle caselle regge 1.4.11 (3:1): `neutral`, non `muted`', () => {
    const { container } = renderTable();
    const caselle = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(caselle.length, 'sonda cieca: nessuna casella da misurare').toBeGreaterThan(0);
    for (const c of caselle) {
      // #9AA6A2 su bianco = 2,51:1 → sotto i 3:1 del contrasto NON testuale, e il
      // fondo del controllo coincide col fondo della card: non c'è altro segno.
      expect(c.className, 'il bordo della casella è l\'unico segno che dice dove sta').not.toContain('border-kidville-muted');
      expect(c.className).toContain('border-kidville-neutral');
    }
  });
});

// =============================================================================
describe('S38bis · ORDINARE la tabella è possibile anche senza mouse', () => {
  // Le intestazioni ordinabili erano `<th onClick>`: nessun `role`, nessun
  // `tabIndex`, nessun `onKeyDown` — quindi non un tab stop e sorde a
  // Invio/Spazio. Da tastiera l'anagrafica NON si poteva ordinare in nessun
  // modo (WCAG 2.1.1, livello A), e nessuno strumento diceva quale colonna
  // fosse l'ordinamento corrente (WCAG 1.3.1 + ARIA `aria-sort`).
  //
  // È lo stesso difetto già chiuso in questo file per la RIGA — comando vero
  // dentro la cella, click sulla riga lasciato al mouse — riapparso una cella
  // più in alto. La differenza fra le due non era progettata: era casuale.

  const intestazioniOrdinabili = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('thead th')).filter((th) => th.querySelector('button'));

  it('CONTROLLO POSITIVO: le intestazioni ordinabili esistono e sono più d\'una', () => {
    const { container } = renderTable();
    expect(intestazioniOrdinabili(container).length).toBeGreaterThan(1);
  });

  it('ogni intestazione ordinabile porta un BOTTONE focusabile con il nome della colonna', () => {
    const { container } = renderTable();
    for (const th of intestazioniOrdinabili(container)) {
      const b = th.querySelector('button')!;
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      // WCAG 2.5.3: il nome accessibile contiene l'etichetta VISIBILE della colonna.
      expect((b.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('lo stato dell\'ordinamento è dichiarato con `aria-sort` sulla colonna giusta', () => {
    const { container } = renderTable();
    const th = intestazioniOrdinabili(container);
    const valori = th.map((x) => x.getAttribute('aria-sort'));
    // Una sola colonna ordinata alla volta; le altre dichiarano «none».
    expect(valori.filter((v) => v === 'ascending' || v === 'descending')).toHaveLength(1);
    expect(valori.every((v) => v !== null)).toBe(true);
  });

  it('premere il bottone inverte il verso, e `aria-sort` lo segue', () => {
    const { container } = renderTable();
    const ordinata = () => intestazioniOrdinabili(container).find((x) => x.getAttribute('aria-sort') !== 'none')!;
    expect(ordinata().getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(ordinata().querySelector('button')!);
    expect(ordinata().getAttribute('aria-sort')).toBe('descending');
  });
});
