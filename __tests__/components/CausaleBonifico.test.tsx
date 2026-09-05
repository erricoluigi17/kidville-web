import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CausaleBonifico } from '@/components/features/parent/pagamenti/CausaleBonifico';

// La causale ora è COMPOSTA DAL SERVER (modello per-categoria) e passata già pronta:
// il componente la mostra soltanto. CF SINTETICI (nessuna persona reale, repo pubblico).
const voci = [
  { id: 'p1', scuola_id: 'sede-1', descrizione: 'Retta Settembre 2026', importo: 250, causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO', nome: 'Mara', cognome: 'Bianchi', hasCf: true },
  { id: 'p2', scuola_id: 'sede-1', descrizione: 'Iscrizione 2026/27', importo: 90.5, causale: 'Iscrizione - per il minore Ugo Verdi - GIUGLIANO', nome: 'Ugo', cognome: 'Verdi', hasCf: false },
];

const scrivi = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: scrivi }, configurable: true });
});

describe('CausaleBonifico — formato completo + a11y (A4·A5)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('mostra la causale che arriva dal server (una per voce)', () => {
    render(<CausaleBonifico voci={voci} />);
    expect(screen.getByText('Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO')).toBeInTheDocument();
    // voce senza CF: la causale resta utile (descrizione + minore + sede)
    expect(screen.getByText('Iscrizione - per il minore Ugo Verdi - GIUGLIANO')).toBeInTheDocument();
  });

  it('A5: il CTA «Copia» è bianco su verde (AA), non giallo-su-verde — uno per voce', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    expect(screen.getAllByRole('button', { name: /Copia la causale/ }).length).toBe(2);
    const html = container.innerHTML;
    expect(html).toContain('bg-kidville-green');
    expect(html).toContain('text-kidville-white');
    expect(html).not.toContain('text-kidville-yellow');
  });

  it('A4: i testi informativi non usano `muted` (sotto AA) ma `sub`', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const html = container.innerHTML;
    expect(screen.getByText(/Copiala così com’è/)).toBeInTheDocument();
    expect(screen.getByText(/Codice fiscale non disponibile/)).toBeInTheDocument();
    expect(html).not.toContain('text-kidville-muted');
    expect(html).toContain('text-kidville-sub');
  });
});

/**
 * `incorporata` — la stessa lista dentro un'altra card («Come pagare», E4).
 *
 * Due card annidate darebbero due bordi, due fondi bianchi e due titoli: la
 * causale è UNA sezione del bonifico, non una scheda a sé. La prop toglie il
 * guscio e l'occhiello, e NIENT'ALTRO: la lista e le sue conferme di copia
 * restano quelle di sempre — motivo per cui i test qui sopra non si toccano.
 */
describe('CausaleBonifico — variante incorporata (E4)', () => {
  it('senza la prop resta la card di oggi: guscio + occhiello', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const radice = container.firstElementChild as HTMLElement;
    expect(radice.className).toContain('rounded-card');
    expect(radice.className).toContain('border-kidville-line');
    expect(radice.className).toContain('bg-kidville-white');
    expect(screen.getByText('Causale consigliata per il bonifico')).toBeInTheDocument();
  });

  it('con `incorporata` sparisce il guscio esterno e l’occhiello, resta la lista', () => {
    const { container } = render(<CausaleBonifico voci={voci} incorporata />);
    const radice = container.firstElementChild as HTMLElement;
    expect(radice.className).not.toContain('rounded-card');
    expect(radice.className).not.toContain('border-kidville-line');
    expect(radice.className).not.toContain('bg-kidville-white');
    expect(screen.queryByText('Causale consigliata per il bonifico')).toBeNull();
    // L'intro e le causali restano: è ciò che il genitore deve copiare.
    expect(screen.getByText(/Copiala così com’è/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Copia la causale/ })).toHaveLength(2);
    expect(screen.getByText(voci[0].causale)).toBeInTheDocument();
  });
});

/**
 * Il secondo giro (2026-09-05). Sulla schermata a 390px la riga della causale era
 * un blocco di quattro righe in VERDE GRASSETTO a 14px con un bottone che ci
 * galleggiava accanto: il testo da copiare — che nessuno legge, si copia — era
 * l'elemento più forte della card, e si mangiava il punto focale all'IBAN. E la
 * riga non diceva NÉ quale voce fosse NÉ quanto restasse da versare: per saperlo
 * bisognava leggere la causale parola per parola, tre volte quasi identiche.
 */
describe('CausaleBonifico — la riga si riconosce dalla voce, non dalla causale', () => {
  it('ogni riga dice la propria voce e quanto resta, in euro italiani', () => {
    render(<CausaleBonifico voci={voci} />);
    expect(screen.getByText('Retta Settembre 2026')).toBeInTheDocument();
    expect(screen.getByText('€ 250,00')).toBeInTheDocument();
    expect(screen.getByText('Iscrizione 2026/27')).toBeInTheDocument();
    expect(screen.getByText('€ 90,50')).toBeInTheDocument();
  });

  it('la causale è il TESTO DA COPIARE: campo chiaro, non titolo verde grassetto', () => {
    render(<CausaleBonifico voci={voci} />);
    const campo = screen.getByText(voci[0].causale);
    expect(campo.className).toContain('bg-kidville-white');
    expect(campo.className).not.toContain('text-kidville-green');
    expect(campo.className).not.toContain('font-bold');
  });

  it('il bottone non cambia misura fra «Copia» e «Copiato», e regge il dito', () => {
    render(<CausaleBonifico voci={voci} />);
    const [primo] = screen.getAllByRole('button', { name: /Copia la causale/ });
    expect(primo.className).toContain('min-w-[6.5rem]');
    expect(primo.className).toContain('min-h-[44px]');
  });

  it('a copia avvenuta il nome accessibile resta contestuale (WCAG 2.5.3)', async () => {
    render(<CausaleBonifico voci={voci} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copia la causale di Mara Bianchi' }));
    expect(scrivi).toHaveBeenCalledWith(voci[0].causale);
    // Il testo visibile diventa «Copiato»: il nome accessibile deve contenerlo E
    // dire ancora di quale voce si parla, altrimenti in una lista di tre bottoni
    // identici si perde il riferimento.
    expect(await screen.findByRole('button', { name: 'Copiato: causale di Mara Bianchi' })).toBeInTheDocument();
  });
});
