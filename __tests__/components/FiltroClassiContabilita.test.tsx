import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { FiltroClassiContabilita } from '@/components/features/admin/pagamenti/FiltroClassiContabilita';
import { NOME_CLASSE_ASSENTE, type ClasseFiltro } from '@/lib/pagamenti/filtro-classi';
import { BERSAGLIO_TOCCO } from '@/components/ui/FoglioFiltri';

// =============================================================================
// `FiltroClassiContabilita` (K6) — il controllo di selezione MULTIPLA delle
// classi nella contabilità.
//
// Cosa difendono questi test:
//  · con più sedi le classi omonime sono DUE voci, e il nome accessibile di
//    ciascuna dice la sede («Sezione A — Giugliano»): chi usa uno screen reader
//    non deve indovinare di quale plesso è la «Sezione A» che sta premendo;
//  · nessuna selezione = «Tutte le classi», ed è anche il comando che azzera;
//  · il pannello è una disclosure (`aria-expanded` + `aria-controls`), Escape
//    chiude e il fuoco torna al comando (WCAG 2.4.3);
//  · niente violazioni axe a pannello aperto.
//
// Dati inventati, nessuna PII (il repo è pubblico).
// =============================================================================

expect.extend(toHaveNoViolations);

const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
};

const CLASSI: ClasseFiltro[] = [
  { id: 'a-a', nome: 'Sezione A', scuolaId: 'ave', scuolaNome: 'Aversa' },
  { id: 'g-a', nome: 'Sezione A', scuolaId: 'giu', scuolaNome: 'Giugliano' },
  { id: 'g-b', nome: 'Sezione B', scuolaId: 'giu', scuolaNome: 'Giugliano' },
];

/** Il comando che apre il pannello: il suo nome è «Classe <riepilogo>». */
function comando() {
  return screen.getByRole('button', { name: /^Classe / });
}

function apri() {
  const btn = comando();
  fireEvent.click(btn);
  return btn;
}

/** Un genitore VERO, con stato: il componente è controllato. */
function ConStato({ iniziali = [] as string[], mostraSede = true }) {
  const [sel, setSel] = useState<string[]>(iniziali);
  return <FiltroClassiContabilita classi={CLASSI} selezionate={sel} onChange={setSel} mostraSede={mostraSede} />;
}

describe('FiltroClassiContabilita — riepilogo sul comando', () => {
  it('nessuna selezione: il comando dice «Tutte le classi», col nome del campo', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={[]} onChange={() => {}} mostraSede />);
    const btn = screen.getByRole('button', { name: 'Classe Tutte le classi' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('una classe: il comando la nomina con la sede quando le sedi sono più di una', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['a-a']} onChange={() => {}} mostraSede />);
    expect(screen.getByRole('button', { name: 'Classe Sezione A — Aversa' })).toBeInTheDocument();
  });

  it('una classe, una sede sola: niente sede nel riepilogo', () => {
    // Classi di UNA sede (Giugliano): con classi di due sedi la sede comparirebbe
    // comunque (vedi la difesa più sotto).
    render(
      <FiltroClassiContabilita classi={CLASSI.slice(1)} selezionate={['g-b']} onChange={() => {}} mostraSede={false} />,
    );
    expect(screen.getByRole('button', { name: 'Classe Sezione B' })).toBeInTheDocument();
  });

  it('più classi: il conteggio, al plurale giusto', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['a-a', 'g-b']} onChange={() => {}} mostraSede />);
    expect(screen.getByRole('button', { name: 'Classe 2 classi' })).toBeInTheDocument();
  });

  it('nessuna classe disponibile: il controllo non si disegna', () => {
    const { container } = render(
      <FiltroClassiContabilita classi={[]} selezionate={[]} onChange={() => {}} mostraSede />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FiltroClassiContabilita — pannello e selezione multipla', () => {
  it('con più sedi le omonime sono due voci, raggruppate per sede, col nome della sede nel nome accessibile', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={[]} onChange={() => {}} mostraSede />);
    const btn = apri();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(pannello).toBeVisible();

    const giu = within(pannello).getByRole('group', { name: 'Giugliano' });
    const ave = within(pannello).getByRole('group', { name: 'Aversa' });
    expect(within(giu).getByRole('button', { name: 'Sezione A — Giugliano' })).toBeInTheDocument();
    expect(within(giu).getByRole('button', { name: 'Sezione B — Giugliano' })).toBeInTheDocument();
    expect(within(ave).getByRole('button', { name: 'Sezione A — Aversa' })).toBeInTheDocument();
    expect(within(ave).queryByRole('button', { name: /Giugliano/ })).toBeNull();
  });

  it('con una sede sola: un gruppo «Classi» e nomi senza sede', () => {
    render(<FiltroClassiContabilita classi={CLASSI.slice(1)} selezionate={[]} onChange={() => {}} mostraSede={false} />);
    apri();
    const gruppo = screen.getByRole('group', { name: 'Classi' });
    expect(within(gruppo).getByRole('button', { name: 'Sezione A' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Giugliano' })).toBeNull();
  });

  it('premere una classe la AGGIUNGE alla selezione (multipla), ripremerla la toglie', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FiltroClassiContabilita classi={CLASSI} selezionate={['g-a']} onChange={onChange} mostraSede />,
    );
    apri();
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Aversa' }));
    expect(onChange).toHaveBeenLastCalledWith(['g-a', 'a-a']);

    rerender(<FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'a-a']} onChange={onChange} mostraSede />);
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Giugliano' }));
    expect(onChange).toHaveBeenLastCalledWith(['a-a']);
  });

  it('«Tutte le classi» azzera la selezione ed è premuto solo quando niente è scelto', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FiltroClassiContabilita classi={CLASSI} selezionate={['g-b']} onChange={onChange} mostraSede />,
    );
    const btn = apri();
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    const tutte = within(pannello).getByRole('button', { name: 'Tutte le classi' });
    expect(tutte).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tutte);
    expect(onChange).toHaveBeenLastCalledWith([]);

    rerender(<FiltroClassiContabilita classi={CLASSI} selezionate={[]} onChange={onChange} mostraSede />);
    expect(within(pannello).getByRole('button', { name: 'Tutte le classi' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('con un genitore vero: due classi premute restano entrambe premute e il riepilogo le conta', () => {
    render(<ConStato />);
    apri();
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Giugliano' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Aversa' }));
    expect(screen.getByRole('button', { name: 'Sezione A — Giugliano' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sezione A — Aversa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sezione B — Giugliano' })).toHaveAttribute('aria-pressed', 'false');
    expect(comando()).toHaveAccessibleName('Classe 2 classi');
  });

  it('Escape chiude il pannello e il fuoco torna al comando', () => {
    render(<ConStato />);
    const btn = apri();
    const voce = screen.getByRole('button', { name: 'Sezione B — Giugliano' });
    voce.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(btn.getAttribute('aria-controls')!)).not.toBeVisible();
    expect(btn).toHaveFocus();
  });

  // Un clic vero è mousedown → mouseup → click, e l'ascoltatore del «clic fuori»
  // sta sul MOUSEDOWN. `fireEvent.click` da solo non lo sveglia mai: qui si
  // manda anche il mousedown, sulla pastiglia, come fa il browser. Se il
  // pannello si chiudesse al mousedown di una sua voce (ascoltatore che non
  // guarda il bersaglio, o pannello spostato fuori dal contenitore, es. un
  // portal) col mouse si sceglierebbe UNA classe sola: la selezione multipla,
  // decisione del titolare, non esisterebbe più.
  it('un clic DENTRO il pannello lo lascia aperto: col mouse si scelgono due classi di fila', () => {
    render(<ConStato />);
    const btn = apri();
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;

    const giu = screen.getByRole('button', { name: 'Sezione A — Giugliano' });
    fireEvent.mouseDown(giu);
    fireEvent.mouseUp(giu);
    fireEvent.click(giu);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(pannello).toBeVisible();

    // `getByRole` non trova i nodi dentro un pannello `hidden`: se il primo
    // mousedown lo avesse chiuso, qui il test si fermerebbe.
    const ave = screen.getByRole('button', { name: 'Sezione A — Aversa' });
    fireEvent.mouseDown(ave);
    fireEvent.mouseUp(ave);
    fireEvent.click(ave);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(pannello).toBeVisible();

    expect(screen.getByRole('button', { name: 'Sezione A — Giugliano' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sezione A — Aversa' })).toHaveAttribute('aria-pressed', 'true');
    expect(comando()).toHaveAccessibleName('Classe 2 classi');
  });

  it('un clic fuori chiude il pannello', () => {
    render(
      <div>
        <p>fuori</p>
        <ConStato />
      </div>,
    );
    const btn = apri();
    fireEvent.mouseDown(screen.getByText('fuori'));
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});

// Una selezione SCADUTA: id che non corrispondono più a nessuna classe in
// elenco. Caso vero: la segreteria sceglie «Sezione A — Giugliano», poi cambia
// sede nel SedeSelector; le righe si ricaricano e lo stato del genitore resta
// ['g-a']. Il comando non deve annunciare una classe che non si vede, e deve
// restare un modo per azzerare anche quando l'elenco è vuoto.
describe('FiltroClassiContabilita — selezione che non corrisponde più alle classi', () => {
  it('classi vuote ma una selezione attiva: il controllo resta, e «Tutte le classi» azzera', () => {
    const onChange = vi.fn();
    render(<FiltroClassiContabilita classi={[]} selezionate={['x']} onChange={onChange} mostraSede />);
    const btn = screen.getByRole('button', { name: 'Classe Classi non più disponibili' });
    fireEvent.click(btn);
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    // Nessun gruppo vuoto disegnato: solo il comando che azzera.
    expect(within(pannello).queryByRole('group', { name: 'Classi' })).toBeNull();
    const tutte = within(pannello).getByRole('button', { name: 'Tutte le classi' });
    expect(tutte).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tutte);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('un solo id sconosciuto: il riepilogo NON dice «1 classe» e nessuna pastiglia risulta premuta', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['sconosciuto']} onChange={() => {}} mostraSede />);
    const btn = comando();
    expect(btn).toHaveAccessibleName('Classe Classi non più disponibili');
    fireEvent.click(btn);
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    const premute = within(pannello)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(premute).toHaveLength(0);
  });

  it('un id valido e uno scaduto: il riepilogo conta solo quello che si vede', () => {
    render(
      <FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'sconosciuto']} onChange={() => {}} mostraSede />,
    );
    // Non «2 classi»: una sola pastiglia è premuta, e il riepilogo la nomina.
    expect(comando()).toHaveAccessibleName('Classe Sezione A — Giugliano');
  });

  it('toccare una classe butta via gli id scaduti invece di tenerli nascosti nello stato', () => {
    const onChange = vi.fn();
    render(
      <FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'sconosciuto']} onChange={onChange} mostraSede />,
    );
    apri();
    fireEvent.click(screen.getByRole('button', { name: 'Sezione B — Giugliano' }));
    expect(onChange).toHaveBeenLastCalledWith(['g-a', 'g-b']);
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Giugliano' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

// Una sede assente dalla mappa dei nomi: `classiDaAlunni` dà `scuolaNome: ''`
// e non inventa un nome. Con più sedi il componente NON deve lasciare una
// legenda vuota né fondere due sedi ignote in gruppi indistinguibili: sarebbe
// l'ambiguità che la decisione del titolare vuole evitare.
describe('FiltroClassiContabilita — sede senza nome, con più sedi', () => {
  it('una sede ignota: legenda «Sede non indicata» e nome accessibile che la porta, senza trattino appeso', () => {
    const classi: ClasseFiltro[] = [
      { id: 'x-a', nome: 'Sezione A', scuolaId: 'ignota', scuolaNome: '' },
      ...CLASSI,
    ];
    render(<FiltroClassiContabilita classi={classi} selezionate={[]} onChange={() => {}} mostraSede />);
    apri();
    const gruppo = screen.getByRole('group', { name: 'Sede non indicata' });
    const voce = within(gruppo).getByRole('button', { name: 'Sezione A — Sede non indicata' });
    expect(voce).toHaveTextContent('Sezione A');
    // Nessun fieldset con legenda vuota o col ripiego generico «Classi».
    for (const fs of document.querySelectorAll('fieldset')) {
      expect(fs.querySelector('legend')?.textContent?.trim()).toBeTruthy();
    }
    expect(screen.queryByRole('group', { name: 'Classi' })).toBeNull();
    // Nessun nome accessibile che finisce col separatore.
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-label') ?? '').not.toMatch(/—\s*$/);
    }
  });

  it('due sedi ignote con classi omonime: due gruppi distinti e due nomi distinti', () => {
    const classi: ClasseFiltro[] = [
      { id: 'x-a', nome: 'Sezione A', scuolaId: 'ignota-1', scuolaNome: '' },
      { id: 'y-a', nome: 'Sezione A', scuolaId: 'ignota-2', scuolaNome: '' },
    ];
    render(<FiltroClassiContabilita classi={classi} selezionate={['y-a']} onChange={() => {}} mostraSede />);
    expect(comando()).toHaveAccessibleName('Classe Sezione A — Sede non indicata 2');
    apri();
    const g1 = screen.getByRole('group', { name: 'Sede non indicata 1' });
    const g2 = screen.getByRole('group', { name: 'Sede non indicata 2' });
    expect(within(g1).getByRole('button', { name: 'Sezione A — Sede non indicata 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(g2).getByRole('button', { name: 'Sezione A — Sede non indicata 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// Difesa contro un genitore che calcola male `mostraSede`. Caso vero: in
// `useSediAttive()` `selezionate` vuoto significa «TUTTE le sedi», quindi
// `mostraSede={selezionate.length > 1}` dà `false` proprio con tre sedi
// visibili. Se le classi coprono più di una sede, la sede si mostra comunque:
// due pastiglie «Sezione A» indistinguibili sono ciò che il titolare ha escluso.
describe('FiltroClassiContabilita — classi di più sedi anche con mostraSede={false}', () => {
  it('le omonime di due sedi hanno due nomi accessibili distinti, e il riepilogo dice la sede', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['a-a']} onChange={() => {}} mostraSede={false} />);
    expect(comando()).toHaveAccessibleName('Classe Sezione A — Aversa');
    apri();
    expect(screen.getByRole('button', { name: 'Sezione A — Giugliano' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sezione A — Aversa' })).toHaveAttribute('aria-pressed', 'true');
    // Nessuna pastiglia col solo nome «Sezione A» (ambigua fra le due sedi).
    expect(screen.queryByRole('button', { name: 'Sezione A' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Giugliano' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Aversa' })).toBeInTheDocument();
  });

  it('classi di una sede sola con mostraSede={false}: niente sede, come prima', () => {
    render(<FiltroClassiContabilita classi={CLASSI.slice(1)} selezionate={[]} onChange={() => {}} mostraSede={false} />);
    apri();
    expect(screen.getByRole('button', { name: 'Sezione A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Giugliano/ })).toBeNull();
  });
});

// Un id ripetuto in `selezionate` (da un parametro URL o da un genitore che
// accoda senza controllare): il componente conta le classi, non le occorrenze.
describe('FiltroClassiContabilita — id ripetuti in selezionate', () => {
  it('lo stesso id due volte: il riepilogo nomina la classe (non «2 classi») e una sola pastiglia è premuta', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'g-a']} onChange={() => {}} mostraSede />);
    const btn = comando();
    expect(btn).toHaveAccessibleName('Classe Sezione A — Giugliano');
    fireEvent.click(btn);
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    const premute = within(pannello)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(premute).toHaveLength(1);
  });

  it('togliere la classe ripetuta la toglie del tutto', () => {
    const onChange = vi.fn();
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'g-a']} onChange={onChange} mostraSede />);
    apri();
    fireEvent.click(screen.getByRole('button', { name: 'Sezione A — Giugliano' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  // Il test qui sopra è verde anche senza deduplicazione (`filter` toglie
  // tutte le copie). Questo invece AGGIUNGE partendo da un id ripetuto: se la
  // deduplicazione vivesse solo nel conteggio del riepilogo, `onChange`
  // riceverebbe ['g-a','g-a','g-b'] e l'id doppio finirebbe in `section_ids`.
  it('aggiungere una classe partendo da un id ripetuto restituisce id senza ripetizioni', () => {
    const onChange = vi.fn();
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={['g-a', 'g-a']} onChange={onChange} mostraSede />);
    apri();
    fireEvent.click(screen.getByRole('button', { name: 'Sezione B — Giugliano' }));
    expect(onChange).toHaveBeenLastCalledWith(['g-a', 'g-b']);
  });
});

// Una classe il cui nome non è scritto su nessun alunno arriva da
// `classiDaAlunni` col ripiego `NOME_CLASSE_ASSENTE` («—»). Un bottone che si
// chiama «—» lo screen reader lo legge come «trattino» o come niente: il
// componente mette un testo tradotto.
describe('FiltroClassiContabilita — classe senza nome', () => {
  const SENZA_NOME: ClasseFiltro = { id: 'g-x', nome: NOME_CLASSE_ASSENTE, scuolaId: 'giu', scuolaNome: 'Giugliano' };

  it('una sede: la pastiglia si chiama «Classe senza nome», nel testo e nel nome accessibile, e così il riepilogo', () => {
    render(
      <FiltroClassiContabilita
        classi={[SENZA_NOME, ...CLASSI.slice(1)]}
        selezionate={['g-x']}
        onChange={() => {}}
        mostraSede={false}
      />,
    );
    expect(comando()).toHaveAccessibleName('Classe Classe senza nome');
    apri();
    const voce = screen.getByRole('button', { name: 'Classe senza nome' });
    expect(voce).toHaveTextContent('Classe senza nome');
    expect(voce).toHaveAttribute('aria-pressed', 'true');
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent?.trim()).not.toBe(NOME_CLASSE_ASSENTE);
    }
  });

  it('più sedi: «Classe senza nome — Giugliano», non «— — Giugliano»', () => {
    render(
      <FiltroClassiContabilita classi={[...CLASSI, SENZA_NOME]} selezionate={[]} onChange={() => {}} mostraSede />,
    );
    apri();
    expect(screen.getByRole('button', { name: 'Classe senza nome — Giugliano' })).toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-label') ?? '').not.toMatch(/^—/);
    }
  });
});

// jsdom non calcola il CSS: qui si fissa che le classi del bersaglio di tocco
// ci siano, e che quello delle pastiglie sia la costante del design system.
describe('FiltroClassiContabilita — bersagli da 44px sul telefono', () => {
  it('il comando è alto 44px sotto `sm` e le pastiglie usano `BERSAGLIO_TOCCO`', () => {
    render(<FiltroClassiContabilita classi={CLASSI} selezionate={[]} onChange={() => {}} mostraSede />);
    const btn = apri();
    expect(btn.className.split(/\s+/)).toContain('max-sm:h-[44px]');
    const pannello = document.getElementById(btn.getAttribute('aria-controls')!)!;
    for (const p of within(pannello).getAllByRole('button')) {
      const classi = p.className.split(/\s+/);
      expect(classi).toContain(BERSAGLIO_TOCCO);
      // Da `sm` in su il bersaglio torna quello della barra filtri.
      expect(classi).toContain('sm:min-h-0');
    }
  });
});

describe('FiltroClassiContabilita — axe', () => {
  it('nessuna violazione a pannello aperto, con una selezione', async () => {
    const { container } = render(<ConStato iniziali={['g-a']} />);
    apri();
    expect(await axe(container, axeOpts)).toHaveNoViolations();
  });
});
