import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavigatoreData } from '@/components/ui/NavigatoreData';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';

/**
 * `NavigatoreData` — il navigatore di date riusabile.
 *
 * Il test che conta più di tutti è il gruppo «la stringa vuota non esce MAI»:
 * `DateField` emette `onChange('')` a ogni battuta intermedia, e prima di questo
 * componente quella stringa vuota finiva dritta in una query (`?data=`), con
 * l'API a 400 e il banner rosso a video mentre l'utente stava ancora scrivendo.
 * Qui si verifica che NON esca — né dal campo né dalle FRECCE, che sono l'altra
 * porta: `addGiorni` su una non-data la restituisce invariata — e, l'altra metà
 * del difetto, che assorbirla non renda il campo indigitabile.
 *
 * Controprove eseguite prima di consegnare (ogni volta rompendo il codice
 * davvero e guardando il rosso):
 *  · tolto l'assorbimento (`onChange(iso)` sempre) → rosso «data incompleta»;
 *  · tolta la bozza (`value={value}` a `DateField`) → rosso «data completa»;
 *  · tolta la guardia sulle frecce → rosso «da un `value` non navigabile»;
 *  · `oggiFiscaleISO()` → `new Date().toISOString().slice(0,10)` → rosso
 *    «a cavallo della mezzanotte italiana»;
 *  · bozza tenuta anche sull'ISO completo → rosso «il chiamante rifiuta»;
 *  · tolto il riempimento dell'anno in `addGiorni` → rosso «l'anno a tre cifre»;
 *  · tolta la guardia sull'USCITA delle frecce → rosso «al tetto del calendario»;
 *  · «Oggi» mostrato senza guardare i limiti → rosso ««Oggi» sparisce»;
 *  · tolto `setBozza(null)` dalla freccia → rosso «anche una FRECCIA rifiutata».
 */

/**
 * Involucro CONTROLLATO, come lo userà una pagina vera: senza di lui il `value`
 * non si muoverebbe mai e metà dei comportamenti non sarebbe osservabile.
 */
function Controllato({
  iniziale,
  spia,
  'aria-label': ariaLabel = 'Giorno del registro',
  ...resto
}: {
  iniziale: string;
  spia: (iso: string) => void;
  max?: string;
  min?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const [valore, setValore] = useState(iniziale);
  return (
    <NavigatoreData
      value={valore}
      onChange={(iso) => {
        spia(iso);
        setValore(iso);
      }}
      aria-label={ariaLabel}
      {...resto}
    />
  );
}

/**
 * Involucro che RIFIUTA le date oltre `tetto`, come il commento del componente
 * istruisce a fare (un campo mascherato non può imporre `min`/`max` da sé): la
 * spia vede l'ISO, ma `value` non si muove.
 */
function ControllatoConRifiuto({
  iniziale,
  tetto,
  spia,
}: {
  iniziale: string;
  tetto: string;
  spia: (iso: string) => void;
}) {
  const [valore, setValore] = useState(iniziale);
  return (
    <NavigatoreData
      value={valore}
      onChange={(iso) => {
        spia(iso);
        if (iso <= tetto) setValore(iso);
      }}
      aria-label="Giorno del registro"
    />
  );
}

const campo = () => screen.getByRole('textbox') as HTMLInputElement;
const indietro = () => screen.getByRole('button', { name: 'Giorno precedente' });
const avanti = () => screen.getByRole('button', { name: 'Giorno successivo' });
const oggiBottone = () => screen.getByRole('button', { name: 'Oggi' });

/** Digita una cifra alla volta, come farebbe una tastiera vera sul campo mascherato. */
function digita(cifre: string) {
  for (const cifra of cifre) {
    fireEvent.change(campo(), { target: { value: campo().value + cifra } });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NavigatoreData — le frecce', () => {
  it('‹ porta al giorno precedente (14/09/2026 lunedì → 13/09/2026 domenica)', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);
    fireEvent.click(indietro());
    expect(spia).toHaveBeenCalledTimes(1);
    expect(spia).toHaveBeenCalledWith('2026-09-13');
    expect(campo().value).toBe('13/09/2026');
  });

  it('› porta al giorno successivo', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);
    fireEvent.click(avanti());
    expect(spia).toHaveBeenCalledTimes(1);
    expect(spia).toHaveBeenCalledWith('2026-09-15');
    expect(campo().value).toBe('15/09/2026');
  });

  it('senza `max` la freccia › NON è mai bloccata (nel registro si va anche avanti)', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} />);
    expect(avanti()).not.toBeDisabled();
  });

  it('con `max` uguale al valore corrente la freccia › è disabilitata', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} max="2026-09-14" />);
    expect(avanti()).toBeDisabled();
    // e la ‹ resta libera: `max` non è un blocco su entrambi i lati
    expect(indietro()).not.toBeDisabled();
  });

  it('senza `min` la freccia ‹ NON è mai bloccata; con `min` al valore corrente sì', () => {
    const { unmount } = render(<Controllato iniziale="2026-09-14" spia={vi.fn()} />);
    expect(indietro()).not.toBeDisabled();
    unmount();

    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} min="2026-09-14" />);
    expect(indietro()).toBeDisabled();
    expect(avanti()).not.toBeDisabled();
  });

  /**
   * I LIMITI NON SI CREDONO SULLA PAROLA. Senza controllo, sbagliare il formato di
   * `max` dava due guasti muti in direzioni OPPOSTE — misurati:
   *  · `max="19/09/2026"` (formato italiano per sbaglio): il confronto fra stringhe
   *    `'2026-09-14' >= '19/09/2026'` è vero, e la `›` restava disabilitata PER
   *    SEMPRE, indistinguibile da una configurazione corretta;
   *  · `min="2026-9-5"` (ISO senza zeri): `'2026-09-14' <= '2026-9-5'` è vero
   *    perché `'0' < '9'`, e la `‹` moriva allo stesso modo.
   * I due test qui sopra, con limiti VERI che mordono, sono il controllo che
   * impedisce a questa correzione di diventare «ignora sempre tutto».
   */
  it('un `max` nel formato italiano (sbagliato) viene IGNORATO invece di uccidere la freccia', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} max="19/09/2026" />);
    expect(avanti()).not.toBeDisabled();
  });

  it('un `min` ISO senza zeri (sbagliato) viene IGNORATO invece di uccidere la freccia', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} min="2026-9-5" />);
    expect(indietro()).not.toBeDisabled();
  });
});

/**
 * 🔑 L'ALTRA METÀ DELLA GUARDIA: l'USCITA delle frecce, non solo il loro ingresso.
 *
 * `addGiorni` ai due estremi del calendario risponde con una forma che ISO non è —
 * misurato: `'0202-06-15' → '202-06-16'` (tre cifre d'anno, prima del riempimento)
 * e `'9999-12-31' → '10000-01-01'` (cinque). Il `value` di partenza, in entrambi i
 * casi, è un giorno verissimo: la guardia sull'ingresso li lascia passare tutti e
 * due, e l'anno `0202` si raggiunge dalla TASTIERA.
 */
describe('NavigatoreData — dalle frecce non esce MAI un ISO malformato', () => {
  it('l\'anno a tre cifre si raggiunge digitando, e la freccia lo riemette a QUATTRO', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);

    // `15060202` → `15/06/0202`, un giorno vero del calendario: esce come ISO.
    fireEvent.change(campo(), { target: { value: '' } });
    digita('15060202');
    expect(spia).toHaveBeenCalledExactlyOnceWith('0202-06-15');

    spia.mockClear();
    fireEvent.click(avanti());
    // senza il riempimento dell'anno qui usciva `'202-06-16'`
    expect(spia).toHaveBeenCalledExactlyOnceWith('0202-06-16');
  });

  it('al tetto del calendario la › non emette un anno a CINQUE cifre (e la ‹ cammina ancora)', () => {
    const spia = vi.fn();
    render(<NavigatoreData value="9999-12-31" onChange={spia} aria-label="Giorno del registro" />);

    // il blocco NON è sull'ingresso: 31/12/9999 è un giorno vero, la freccia è viva
    expect(avanti()).not.toBeDisabled();
    fireEvent.click(avanti());
    expect(spia).not.toHaveBeenCalled();

    // e non è un vicolo cieco: indietro si va
    fireEvent.click(indietro());
    expect(spia).toHaveBeenCalledExactlyOnceWith('9999-12-30');
  });
});

describe('NavigatoreData — il pulsante «Oggi»', () => {
  it('non compare quando il valore è già oggi', () => {
    render(<Controllato iniziale={oggiFiscaleISO()} spia={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Oggi' })).not.toBeInTheDocument();
  });

  it('compare su un altro giorno e riporta a oggi', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2020-01-07" spia={spia} />);
    fireEvent.click(oggiBottone());
    expect(spia).toHaveBeenCalledWith(oggiFiscaleISO());
    // tornato a oggi, il pulsante sparisce da solo
    expect(screen.queryByRole('button', { name: 'Oggi' })).not.toBeInTheDocument();
  });

  /**
   * 🔑 IL FUSO, E L'ISTANTE IN CUI ROMA E UTC NON SONO D'ACCORDO.
   *
   * Alle 22:30 UTC del 19/09 a Roma è già lo 00:30 del 20/09. `oggiFiscaleISO()`
   * (che chiede il giorno a `Europe/Rome`) dice 2026-09-20; il
   * `new Date().toISOString().slice(0,10)` che sembra equivalente dice
   * 2026-09-19 — ed è la famiglia di difetti che questo repo ha già pagato
   * quattro volte. Senza questo test la sostituzione passava con 13 test verdi,
   * perché i due valori coincidono 22 ore su 24.
   *
   * ⚠️ L'orologio si sposta DOPO il render, di proposito: così il test copre
   * anche l'altra metà: «Oggi» ricalcola la data al CLICK e non la congela al
   * primo render. Una schermata lasciata aperta a cavallo della mezzanotte
   * riporterebbe altrimenti al giorno prima.
   */
  it('a cavallo della mezzanotte italiana «Oggi» è il giorno di ROMA, e si ricalcola al click', () => {
    const spia = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<Controllato iniziale="2020-01-07" spia={spia} />);

    // 19/09 22:30 UTC = 20/09 00:30 a Roma (ora legale, +02:00).
    vi.setSystemTime(new Date('2026-09-19T22:30:00Z'));
    fireEvent.click(oggiBottone());

    expect(spia).toHaveBeenCalledTimes(1);
    expect(spia).toHaveBeenCalledWith('2026-09-20');
  });

  /**
   * «OGGI» OBBEDISCE AGLI STESSI LIMITI DELLE FRECCE.
   *
   * Con `max="2026-09-16"` e oggi 19/09 il pulsante compariva ed emetteva
   * `2026-09-19`: un giorno che la `›` — disabilitata — si rifiutava di
   * raggiungere. Due gesti dello stesso componente, risposte opposte allo stesso
   * limite. L'orologio si congela PRIMA del render perché la visibilità del
   * pulsante si decide lì.
   */
  it('«Oggi» sparisce quando oggi cade FUORI da `min`/`max`', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z')); // mezzogiorno a Roma

    // oggi (19/09) è oltre il tetto
    const { unmount } = render(<Controllato iniziale="2026-09-10" spia={vi.fn()} max="2026-09-16" />);
    expect(screen.queryByRole('button', { name: 'Oggi' })).not.toBeInTheDocument();
    unmount();

    // e sotto il pavimento vale lo stesso, dall'altro lato
    render(<Controllato iniziale="2026-10-05" spia={vi.fn()} min="2026-09-25" />);
    expect(screen.queryByRole('button', { name: 'Oggi' })).not.toBeInTheDocument();
  });

  it('…e resta dov\'era quando oggi è DENTRO i limiti (il pulsante non sparisce per abitudine)', () => {
    const spia = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z'));

    render(
      <Controllato iniziale="2026-09-10" spia={spia} min="2026-09-01" max="2026-09-30" />,
    );
    fireEvent.click(oggiBottone());
    expect(spia).toHaveBeenCalledExactlyOnceWith('2026-09-19');
  });
});

describe('NavigatoreData — accessibilità e stile', () => {
  it('le frecce sono bottoni di tipo `button` con un nome accessibile tradotto', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} />);
    expect(indietro()).toHaveAttribute('type', 'button');
    expect(avanti()).toHaveAttribute('type', 'button');
  });

  it('l\'`aria-label` nomina il CAMPO (e non si ripete sul gruppo)', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} aria-label="Giorno del registro" />);

    // il nome accessibile sta dove serve: sulla textbox
    expect(screen.getByRole('textbox', { name: 'Giorno del registro' })).toBeInTheDocument();
    // e NON è ripetuto sul contenitore: lo stesso nome annunciato due volte è rumore
    expect(screen.getByRole('group')).not.toHaveAttribute('aria-label');
  });

  it('`className` si SOMMA al layout di base invece di sostituirlo', () => {
    render(<Controllato iniziale="2026-09-14" spia={vi.fn()} className="mb-4" />);
    const gruppo = screen.getByRole('group');

    expect(gruppo).toHaveClass('mb-4');
    // senza queste il navigatore si impilerebbe in verticale, in silenzio
    expect(gruppo).toHaveClass('flex', 'items-center', 'gap-2');
  });
});

describe('NavigatoreData — 🔑 la stringa vuota non esce MAI dal componente', () => {
  it('digitando una data INCOMPLETA `onChange` non viene chiamato nemmeno una volta', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);

    // si svuota il campo e si comincia a battere: ognuna di queste battute fa
    // uscire `onChange('')` da DateField, e nessuna deve arrivare fuori.
    fireEvent.change(campo(), { target: { value: '' } });
    digita('1509');
    expect(campo().value).toBe('15/09');
    expect(spia).not.toHaveBeenCalled();

    digita('202');
    expect(campo().value).toBe('15/09/202');
    expect(spia).not.toHaveBeenCalled();
  });

  it('completando la data `onChange` scatta UNA volta con l\'ISO giusto (campo digitabile)', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('15092026');

    // se la bozza interna non ci fosse, il `value` esterno avrebbe riscritto il
    // campo a ogni battuta e qui si leggerebbe ancora «14/09/2026».
    expect(campo().value).toBe('15/09/2026');
    expect(spia).toHaveBeenCalledTimes(1);
    expect(spia).toHaveBeenCalledWith('2026-09-15');
  });

  it('una data impossibile battuta per intero non esce (31/02 non è un giorno)', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('31022026');

    expect(campo().value).toBe('31/02/2026');
    expect(spia).not.toHaveBeenCalled();
  });

  it('dopo una digitazione a metà, le frecce ripartono dal `value` esterno', () => {
    const spia = vi.fn();
    render(<Controllato iniziale="2026-09-14" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('1509');
    expect(spia).not.toHaveBeenCalled();

    fireEvent.click(avanti());
    expect(spia).toHaveBeenCalledTimes(1);
    expect(spia).toHaveBeenCalledWith('2026-09-15');
    // la bozza è stata abbandonata: il campo mostra il valore nuovo, non «15/09»
    expect(campo().value).toBe('15/09/2026');
  });

  /**
   * L'ALTRA PORTA. `addGiorni` su una stringa che non è una data la restituisce
   * INVARIATA di proposito, quindi senza guardia una freccia rimetterebbe in
   * circolo proprio ciò che il campo sta assorbendo: `onChange('')` → `?data=` →
   * 400. Le frecce si bloccano, «Oggi» resta la via d'uscita.
   */
  describe('da un `value` non navigabile le frecce non propagano niente', () => {
    it('con `value` VUOTO ‹ e › sono disabilitate e `onChange` non scatta', () => {
      const spia = vi.fn();
      render(<NavigatoreData value="" onChange={spia} aria-label="Giorno del registro" />);

      expect(avanti()).toBeDisabled();
      expect(indietro()).toBeDisabled();
      fireEvent.click(avanti());
      fireEvent.click(indietro());
      expect(spia).not.toHaveBeenCalled();

      // la via d'uscita c'è: «Oggi» resta attivo e riporta a un giorno vero
      expect(oggiBottone()).not.toBeDisabled();
      fireEvent.click(oggiBottone());
      expect(spia).toHaveBeenCalledExactlyOnceWith(oggiFiscaleISO());
    });

    it('con una data ITALIANA passata per sbaglio al posto dell\'ISO le frecce sono ferme', () => {
      const spia = vi.fn();
      render(<NavigatoreData value="14/09/2026" onChange={spia} aria-label="Giorno del registro" />);

      expect(avanti()).toBeDisabled();
      expect(indietro()).toBeDisabled();
      fireEvent.click(avanti());
      fireEvent.click(indietro());
      expect(spia).not.toHaveBeenCalled();
    });

    it('un ISO di FORMA giusta ma inesistente (31 febbraio) non si muove', () => {
      const spia = vi.fn();
      render(<NavigatoreData value="2026-02-31" onChange={spia} aria-label="Giorno del registro" />);

      expect(avanti()).toBeDisabled();
      expect(indietro()).toBeDisabled();
      fireEvent.click(avanti());
      fireEvent.click(indietro());
      expect(spia).not.toHaveBeenCalled();
    });
  });
});

describe('NavigatoreData — la bozza muore quando l\'ISO è completo', () => {
  /**
   * Il commento del componente istruisce il chiamante a RIFIUTARE le date fuori
   * intervallo (un campo mascherato non può imporre `min`/`max` da sé). Se il
   * chiamante rifiuta, `value` non cambia: tenendo viva la bozza il campo
   * continuerebbe a mostrare un giorno che lo stato reale non ha.
   */
  it('se il chiamante rifiuta la data, il campo torna al valore vero', () => {
    const spia = vi.fn();
    render(<ControllatoConRifiuto iniziale="2026-09-14" tetto="2026-09-14" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('20092026');

    // l'ISO è uscito (il chiamante deve poterlo valutare)…
    expect(spia).toHaveBeenCalledExactlyOnceWith('2026-09-20');
    // …ma essendo stato rifiutato, il campo non resta su una data che non esiste
    // nello stato: `DateField` si riallinea da solo al `value` vero.
    expect(campo().value).toBe('14/09/2026');
  });

  /**
   * DUE VIE DI RIFIUTO, UN SOLO COMPORTAMENTO. La digitazione rifiutata abbandona
   * la bozza (test qui sopra); la FRECCIA rifiutata non lo faceva, e dopo aver
   * battuto `1509` e cliccato `›` il campo restava su «15/09» — un testo
   * incompleto che non corrisponde a nessuno stato, con la freccia che sembrava
   * non aver fatto niente.
   */
  it('anche una FRECCIA rifiutata abbandona la bozza e riallinea il campo', () => {
    const spia = vi.fn();
    render(<ControllatoConRifiuto iniziale="2026-09-14" tetto="2026-09-14" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('1509');
    expect(campo().value).toBe('15/09');

    fireEvent.click(avanti());
    // la freccia riparte dal `value` esterno, e il chiamante la rifiuta…
    expect(spia).toHaveBeenCalledExactlyOnceWith('2026-09-15');
    // …quindi il campo torna alla verità, invece di restare su «15/09»
    expect(campo().value).toBe('14/09/2026');
  });

  it('se il chiamante accetta, il campo mostra la data appena battuta', () => {
    const spia = vi.fn();
    render(<ControllatoConRifiuto iniziale="2026-09-14" tetto="2026-12-31" spia={spia} />);

    fireEvent.change(campo(), { target: { value: '' } });
    digita('20092026');

    expect(spia).toHaveBeenCalledExactlyOnceWith('2026-09-20');
    expect(campo().value).toBe('20/09/2026');
  });
});
