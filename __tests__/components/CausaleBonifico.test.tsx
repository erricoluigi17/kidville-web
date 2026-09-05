import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CausaleBonifico, segmentiCausale } from '@/components/features/parent/pagamenti/CausaleBonifico';

// La causale ora è COMPOSTA DAL SERVER (modello per-categoria) e passata già pronta:
// il componente la mostra soltanto. CF SINTETICI (nessuna persona reale, repo pubblico).
const voci = [
  { id: 'p1', scuola_id: 'sede-1', descrizione: 'Retta Settembre 2026', importo: 250, causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO', nome: 'Mara', cognome: 'Bianchi', hasCf: true },
  { id: 'p2', scuola_id: 'sede-1', descrizione: 'Iscrizione 2026/27', importo: 90.5, causale: 'Iscrizione - per il minore Ugo Verdi - GIUGLIANO', nome: 'Ugo', cognome: 'Verdi', hasCf: false },
];

/**
 * Il campo della causale, cercato PER CONTENUTO.
 *
 * A schermo la causale non è più un unico nodo di testo: i pezzi che non devono
 * spezzarsi a fine riga (la parola incollata al separatore, il cognome composto)
 * stanno in `<span class="whitespace-nowrap">`, e `getByText` confronta solo i
 * figli-testo DIRETTI di un elemento — quindi non troverebbe più niente.
 *
 * Cercare per `textContent` non è un ripiego: è ESATTAMENTE la proprietà che conta.
 * Il testo che si legge, quello che si seleziona col dito e quello che finisce
 * negli appunti devono essere la stessa stringa, carattere per carattere.
 */
function campoCausale(causale: string): HTMLElement {
  const campi = [...document.querySelectorAll<HTMLElement>('.kv-campo-copiabile')];
  const trovato = campi.find((c) => c.textContent === causale);
  if (!trovato) {
    throw new Error(`nessun campo con la causale «${causale}» fra i ${campi.length} presenti: ${campi.map((c) => c.textContent).join(' | ')}`);
  }
  return trovato;
}

const scrivi = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: scrivi }, configurable: true });
});

describe('CausaleBonifico — formato completo + a11y (A4·A5)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('mostra la causale che arriva dal server (una per voce)', () => {
    render(<CausaleBonifico voci={voci} />);
    expect(campoCausale('Retta Settembre 2026 - per il minore Mara Bianchi - ABCDEF00A00A000A - GIUGLIANO')).toBeInTheDocument();
    // voce senza CF: la causale resta utile (descrizione + minore + sede)
    expect(campoCausale('Iscrizione - per il minore Ugo Verdi - GIUGLIANO')).toBeInTheDocument();
  });

  it('A5: il «Copia» della causale è SECONDARIO — verde su crema (5,85:1), uno per voce', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const bottoni = screen.getAllByRole('button', { name: /Copia la causale/ });
    expect(bottoni.length).toBe(2);
    // Erano tre CTA verdi pieni accanto a un quarto («Copia l'IBAN») e al tab
    // attivo: cinque macchie verdi identiche per saturazione, e il bottone che
    // conta davvero si distingueva solo per la larghezza. Qui il contorno basta:
    // verde su crema è 5,85:1, sopra AA, e il pieno resta uno solo in tutta la card.
    for (const b of bottoni) {
      expect(b.className.split(/\s+/)).not.toContain('bg-kidville-green');
      expect(b.className).toContain('text-kidville-green');
      expect(b.className).toContain('border-current');
    }
    expect(container.innerHTML).not.toContain('text-kidville-yellow');
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
    expect(campoCausale(voci[0].causale)).toBeInTheDocument();
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
    const campo = campoCausale(voci[0].causale);
    expect(campo.className).toContain('bg-kidville-white');
    expect(campo.className).not.toContain('text-kidville-green');
    expect(campo.className).not.toContain('font-bold');
  });

  it('l’importo della voce non è verde: in Alto Contrasto il giallo è dei comandi', () => {
    render(<CausaleBonifico voci={voci} />);
    const importo = screen.getByText('€ 250,00');
    // `[data-contrast="high"] .kv-come-pagare .text-kidville-green` porta il verde a
    // #FFE500: con l'importo verde, in Alto Contrasto il giallo lo portavano anche
    // tre numeri che non si premono — e il segnale «questo si tocca» si diluiva su
    // dieci elementi. Nero pieno: in HC diventa bianco insieme al resto del testo.
    expect(importo.className).not.toContain('text-kidville-green');
    expect(importo.className).toContain('text-kidville-ink');
    // …e resta il peso più forte della riga: la gerarchia la fa il nero, non il colore.
    expect(importo.className).toContain('font-black');
  });

  it('il campo della causale non lascia righe orfane e sta a 14px', () => {
    render(<CausaleBonifico voci={voci} />);
    const campo = campoCausale(voci[0].causale);
    // `balance` SOLO sul telefono: su desktop distribuiva le righe lasciando il
    // campo vuoto per un terzo della larghezza, e la scatola sembrava sovradimensionata
    // rispetto al proprio contenuto. Da `sm` in su la riga riempie il campo — l'orfana
    // che cominciava con un trattino è già impedita dai gruppi non spezzabili.
    expect(campo.className).toContain('max-sm:[text-wrap:balance]');
    expect(campo.className).toContain('sm:text-pretty');
    expect(campo.className).toContain('text-sm');
    // Stessa forma dell'IBAN: i due campi da cui si copia si somigliano, e in Alto
    // Contrasto li ribalta la stessa regola (`.kv-campo-copiabile` in globals.css).
    expect(campo.className).toContain('kv-campo-copiabile');
  });

  it('le tre voci non si saldano in un blocco unico', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    // 8px fra card alte 118 saldavano le superfici crema in un blocco a righe:
    // si perdeva il conteggio delle voci a colpo d'occhio.
    expect(container.querySelector('ul')?.className).toContain('space-y-3');
  });

  it('il «Copia» prende la riga intera sul telefono e il margine destro da `sm` in su', () => {
    render(<CausaleBonifico voci={voci} />);
    const [primo] = screen.getAllByRole('button', { name: /Copia la causale/ });
    // Galleggiava su una riga tutta sua occupata per un terzo: 103px di pillola e
    // un centinaio di crema vuota alla sua sinistra, tre volte per schermata.
    expect(primo.className).toContain('w-full');
    expect(primo.className).toContain('sm:w-auto');
    expect(primo.parentElement?.className).toContain('sm:justify-end');
  });

  it('la copia riuscita esce anche da una regione viva, non solo dall’etichetta', async () => {
    render(<CausaleBonifico voci={voci} />);
    const regione = screen.getByRole('status');
    expect(regione.textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Copia la causale di Mara Bianchi' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copiato: causale di Mara Bianchi');
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

/**
 * IL QUARTO GIRO (2026-09-05) — DOVE VA A CAPO LA CAUSALE, e come si vede il fuoco.
 *
 * La causale è l'unica stringa della card che si rilegge carattere per carattere
 * prima di digitarla in banca. Sulle schermate a 390px l'ultima riga era
 * «- GIUGLIANO»: una riga che comincia con un trattino si legge come un elenco
 * puntato, ed era anche corta un terzo della colonna — un'orfana di fatto. L'altro
 * punto di rottura possibile è peggio: il trattino dentro i cognomi composti taglia
 * in due il nome proprio di un bambino («Arcobaleno-» / «Prova»).
 *
 * Nessuna delle due si corregge lato server: la causale che arriva dal GET è quella
 * che deve finire negli APPUNTI, identica.
 *
 * E NON SI CORREGGE NEMMENO COI CARATTERI (quinto giro, 2026-09-05). La prima
 * versione sostituiva lo spazio del separatore con un NBSP e i trattini interni con
 * U+2011: a schermo funzionava, ma il `<p>` resta selezionabile, e chi seleziona la
 * causale col dito — cosa che fa metà delle persone — incollava nell'home banking
 * proprio i due caratteri che questo file dichiarava pericolosi. La correzione col
 * markup non ha quel prezzo: stessa tipografia, e il testo selezionato è identico a
 * quello del server, byte per byte. Il lock qui sotto misura entrambe le metà.
 */
const NBSP = ' ';
/** U+2011 NON-BREAKING HYPHEN: si disegna come un trattino, non apre una riga. */
const TRATTINO_UNITO = '‑';

describe('segmentiCausale — l’a-capo si governa col markup, non coi caratteri', () => {
  const CAUSALE = 'Retta Settembre 2026 - per il minore Mara Bianchi - GIUGLIANO';

  it('rimessi insieme, i segmenti sono la causale del server: carattere per carattere', () => {
    // È l'invariante che rende sicuro tutto il resto: qualunque cosa faccia la
    // segmentazione, il testo a schermo resta quello che va incollato in banca.
    expect(segmentiCausale(CAUSALE).map((s) => s.testo).join(' ')).toBe(CAUSALE);
    const composta = 'Iscrizione - per il minore Ada Lo-Presti-Prova - CESA';
    expect(segmentiCausale(composta).map((s) => s.testo).join(' ')).toBe(composta);
  });

  it('nessun segmento comincia con un trattino: nessuna riga può cominciarci', () => {
    // «- GIUGLIANO» in fondo al campo, largo un terzo della colonna, si legge come
    // un elenco puntato. Il trattino sta nel gruppo non spezzabile della parola che
    // lo precede, quindi non può più aprire una riga.
    for (const s of segmentiCausale(CAUSALE)) expect(s.testo.startsWith('-')).toBe(false);
    expect(segmentiCausale(CAUSALE)).toContainEqual({ testo: '2026 -', unito: true });
    expect(segmentiCausale(CAUSALE)).toContainEqual({ testo: 'Bianchi -', unito: true });
  });

  it('il gruppo incollato al trattino è UNA parola sola, non tutta la frase prima', () => {
    // Legare l'intera corsa di parole al separatore renderebbe non spezzabile un
    // blocco lungo mezza causale: su 390px uscirebbe dal campo.
    for (const s of segmentiCausale(CAUSALE)) {
      if (s.unito) expect(s.testo.split(' ').length).toBeLessThanOrEqual(2);
    }
  });

  it('il cognome composto è un gruppo suo: il nome di un bambino non si taglia a metà', () => {
    const segmenti = segmentiCausale('Retta - per il minore Aurora Arcobaleno-Prova - GIUGLIANO');
    expect(segmenti).toContainEqual({ testo: 'Arcobaleno-Prova -', unito: true });
    // I caratteri restano quelli ORDINARI: è il markup a non farli spezzare.
    expect(segmenti.some((s) => s.testo.includes(TRATTINO_UNITO))).toBe(false);
    expect(segmenti.some((s) => s.testo.includes(NBSP))).toBe(false);
  });

  it('una causale senza separatori resta un segmento solo, e spezzabile', () => {
    expect(segmentiCausale('Retta Settembre 2026')).toEqual([{ testo: 'Retta Settembre 2026', unito: false }]);
  });
});

describe('CausaleBonifico — quello che si legge è quello che si copia', () => {
  const CON_COGNOME_COMPOSTO = [
    {
      id: 'p9',
      scuola_id: 'sede-1',
      descrizione: 'Retta Ottobre 2026',
      importo: 300,
      causale: 'Retta Ottobre 2026 - per il minore Aurora Bianchi-Prova - ABCDEF00A00A000A - GIUGLIANO',
      nome: 'Aurora',
      cognome: 'Bianchi-Prova',
      hasCf: true,
    },
  ];

  it('negli appunti va la causale del server, e a schermo si legge LA STESSA', () => {
    render(<CausaleBonifico voci={CON_COGNOME_COMPOSTO} />);
    fireEvent.click(screen.getByRole('button', { name: /Copia la causale/ }));
    expect(scrivi).toHaveBeenCalledWith(CON_COGNOME_COMPOSTO[0].causale);
    // …e il testo A SCHERMO è identico: chi lo seleziona col dito invece di premere
    // il bottone incolla in banca esattamente la stessa stringa. Era il prezzo della
    // versione coi caratteri sostituiti, e non si paga più.
    expect(campoCausale(CON_COGNOME_COMPOSTO[0].causale).textContent).toBe(CON_COGNOME_COMPOSTO[0].causale);
  });

  it('nel campo non entra NESSUN carattere che la banca non aspetti', () => {
    render(<CausaleBonifico voci={CON_COGNOME_COMPOSTO} />);
    const campo = campoCausale(CON_COGNOME_COMPOSTO[0].causale);
    // La prova negativa: senza di essa l'asserzione qui sopra sarebbe vera anche con
    // una sostituzione che rimpiazzasse un carattere con un altro della stessa forma.
    expect(campo.textContent).not.toContain(NBSP);
    expect(campo.textContent).not.toContain(TRATTINO_UNITO);
  });

  it('a schermo il cognome e il separatore restano legati — col markup', () => {
    render(<CausaleBonifico voci={CON_COGNOME_COMPOSTO} />);
    const campo = campoCausale(CON_COGNOME_COMPOSTO[0].causale);
    const uniti = [...campo.querySelectorAll('.whitespace-nowrap')].map((s) => s.textContent);
    // Il cognome composto sta in un gruppo suo, col separatore incollato: né il nome
    // del bambino si taglia a metà, né una riga può cominciare con un trattino.
    expect(uniti).toContain('Bianchi-Prova -');
    for (const u of uniti) expect(u?.startsWith('-')).toBe(false);
  });
});

describe('CausaleBonifico — il fuoco da tastiera si vede, e il blocco si allinea', () => {
  it('il fuoco da tastiera RIEMPIE il secondario invece di ispessirne il bordo', () => {
    render(<CausaleBonifico voci={voci} />);
    const [primo] = screen.getAllByRole('button', { name: /Copia la causale/ });
    const classi = () => primo.className.split(/\s+/);

    // A riposo è contornato: il pieno della card resta uno solo.
    expect(classi()).not.toContain('bg-kidville-green');

    fireEvent.focus(primo);
    // L'anello globale è `outline: 2px solid #006A5F` e il bordo del bottone è già
    // 2px dello STESSO verde: il cambio di stato si leggeva come «bordo un po' più
    // spesso», non come «sono qui». Al fuoco il bottone si riempie, e l'anello
    // contorna un pieno.
    //
    // La classe è STATICA e non `focus-visible:bg-…`: `.bg-kidville-green` è
    // proprio l'aggancio su cui `globals.css` ribalta il pieno in GIALLO con
    // inchiostro nero in Alto Contrasto. Una variante Tailwind genererebbe un nome
    // di classe diverso, che quella regola non vedrebbe: in Alto Contrasto
    // resterebbe una pillola verde #006A5F su nero, 3,2:1.
    expect(classi()).toContain('bg-kidville-green');
    expect(classi()).toContain('text-kidville-white');

    fireEvent.blur(primo);
    expect(classi()).not.toContain('bg-kidville-green');
  });

  it('col puntatore il pieno NON compare: è un segnale per chi naviga a tastiera', () => {
    render(<CausaleBonifico voci={voci} />);
    const [primo] = screen.getAllByRole('button', { name: /Copia la causale/ });
    fireEvent.pointerDown(primo);
    fireEvent.focus(primo);
    // Col dito o col mouse il bottone cambierebbe colore sotto il dito che l'ha
    // appena toccato, e resterebbe pieno anche dopo: rumore, non stato.
    expect(primo.className.split(/\s+/)).not.toContain('bg-kidville-green');
  });

  it('un clic su un bottone GIÀ a fuoco non spegne il fuoco del TAB successivo', () => {
    render(<CausaleBonifico voci={voci} />);
    const [primo, secondo] = screen.getAllByRole('button', { name: /Copia la causale/ });

    // Tab sul primo: il fuoco si vede.
    fireEvent.focus(primo);
    expect(primo.className.split(/\s+/)).toContain('bg-kidville-green');

    // …poi lo si clicca col mouse. `focus` NON riparte, perché il bottone il fuoco
    // ce l'aveva già: il flag «questo fuoco arriva dal puntatore» veniva alzato da
    // `pointerdown` e abbassato SOLO da `onFocus`, quindi restava alzato per sempre.
    fireEvent.pointerDown(primo);
    fireEvent.pointerUp(primo);
    fireEvent.blur(primo);

    // Il TAB successivo porta il fuoco sul bottone dopo: deve riempirsi. Senza
    // l'azzeramento a fine interazione si ricadeva sull'anello debole — due verdi
    // separati da 2px di crema, cioè «il bordo si è ingrossato».
    fireEvent.focus(secondo);
    expect(secondo.className.split(/\s+/)).toContain('bg-kidville-green');
  });

  it('il blocco della voce porta un bordo invisibile che pareggia la scatola', () => {
    const { container } = render(<CausaleBonifico voci={voci} />);
    const li = container.querySelector('li');
    // Il riquadro del conto ha `border` 1px e i blocchi crema no: stessa scatola
    // esterna, margini interni diversi di 1px, e su desktop i comandi finivano su
    // due colonne distanti un pixel (367,5 contro 368,5). Un bordo trasparente
    // costa niente e li rimette sulla stessa verticale.
    expect(li?.className).toContain('border-transparent');
  });
});
