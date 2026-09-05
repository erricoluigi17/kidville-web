import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog';
import type { MovimentoUi, PagamentoApertoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';

/**
 * FatturaButton fa fetch proprie: stub per isolare il dialog.
 *
 * ⚠️ IL MOCK REGISTRA LE PROPS, e non è un dettaglio: il difetto che questo file
 * blocca è *una prop non passata*. Uno stub che rende soltanto un segnaposto è
 * verde con e senza la correzione — `<FatturaButton pagamentoId userId />` e
 * `<FatturaButton … fatturaStato="emessa" />` producono lo stesso `<span>`.
 */
const spiaFattura = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: (props: Record<string, unknown>) => {
    spiaFattura.props.push(props);
    return (
      <button type="button" data-testid="fattura-button"
        onClick={() => (props.onEmessa as (() => void) | undefined)?.()}>
        Emetti fattura
      </button>
    );
  },
}));

// Etichette dei pagamenti aperti volutamente DISTINTE da quelle dei suggerimenti,
// così un'asserzione sulla ricerca manuale non pesca anche la lista suggerimenti.
const aperti: PagamentoApertoUi[] = [
  { id: 'pa1', descrizione: 'Iscrizione', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Tina', cognome: 'Blu' } },
  { id: 'pa2', descrizione: 'Mensa Novembre', importo: 60, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Ugo', cognome: 'Verdi' } },
];

const movBase: MovimentoUi = {
  id: 'm1',
  data_operazione: '2026-10-05',
  importo: 150,
  causale: 'Bonifico retta RSSMRA85T10A562S',
  controparte: 'Mario Rossi',
  stato: 'suggerito',
  suggerimenti: [
    { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Aldo Neri · Retta Ottobre (residuo € 150,00)' },
    { pagamento_id: 'p2', score: 50, motivi: ['importo esatto'], alunno_id: 'a2', label: 'Bea Neri · Retta Ottobre (residuo € 150,00)' },
  ],
  pagamento_id: null,
};

const ref = () => createRef<HTMLButtonElement>();

describe('MovimentoDialog', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('mostra i suggerimenti ordinati, con badge «CF» sul primo', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/Aldo Neri · Retta Ottobre/)).toBeInTheDocument();
    expect(screen.getByText('CF')).toBeInTheDocument();
    // l'importo è nell'intestazione (heading del dialog)
    expect(screen.getByRole('heading', { name: /150,00/ })).toBeInTheDocument();
  });

  it('«Conferma questo» chiama la PATCH col pagamento_id del suggerimento e chiude', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'p1' }) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('409 «già saldato» → messaggio chiaro, niente chiusura né crash', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Pagamento già saldato: ignora la riga o scegli un'altra voce" }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/già saldato/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('409 corsa persa → messaggio + refetch (onDone)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Movimento già riconciliato da un altro operatore' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Conferma questo/ })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/altro operatore/i);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('la ricerca manuale filtra i pagamenti aperti e abbina quello scelto', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const search = screen.getByLabelText(/Cerca un pagamento aperto/);
    fireEvent.change(search, { target: { value: 'ugo' } });
    // solo Ugo Verdi resta fra i pagamenti aperti; Tina Blu sparisce
    expect(screen.getByText(/Ugo Verdi · Mensa Novembre/)).toBeInTheDocument();
    expect(screen.queryByText(/Tina Blu · Iscrizione/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Abbina/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'pa2' }) }),
    );
  });

  it('«Apri Incasso unico» compare SOLO per i multi-CF e solo se il chiamante lo aggancia', () => {
    vi.stubGlobal('fetch', vi.fn());
    const multiCf: MovimentoUi = {
      ...movBase,
      suggerimenti: [
        { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Figlio 1 · Retta' },
        { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a2', label: 'Figlio 2 · Retta' },
      ],
    };
    const onIncassoUnico = vi.fn();

    // multi-CF con handler → bottone presente
    const { unmount } = render(<MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={onIncassoUnico} />);
    fireEvent.click(screen.getByRole('button', { name: /Apri Incasso unico/ }));
    expect(onIncassoUnico).toHaveBeenCalledWith(multiCf);
    unmount();

    // multi-CF SENZA handler → nessun bottone (solo predisposizione)
    render(<MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.queryByRole('button', { name: /Apri Incasso unico/ })).toBeNull();
  });

  it('A5: i CTA primari del popup sono bianco su verde (AA), mai giallo', () => {
    vi.stubGlobal('fetch', vi.fn());
    const multiCf: MovimentoUi = {
      ...movBase,
      suggerimenti: [
        { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Figlio 1 · Retta' },
        { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a2', label: 'Figlio 2 · Retta' },
      ],
    };
    const { container } = render(
      <MovimentoDialog movimento={multiCf} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={() => {}} />,
    );
    // Conferma questo + Apri Incasso unico + Abbina presenti nella stessa vista
    expect(screen.getAllByRole('button', { name: /Conferma questo/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Apri Incasso unico/ })).toBeInTheDocument();
    // nessun testo giallo-su-verde (~4:1, sotto AA), neppure negli stati :hover
    expect(container.innerHTML).not.toContain('text-kidville-yellow');
  });

  it('non multi-CF → nessun «Apri Incasso unico» anche col handler', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onIncassoUnico={() => {}} />);
    expect(screen.queryByRole('button', { name: /Apri Incasso unico/ })).toBeNull();
  });

  it('movimento confermato + pagamento pagato → Ricevuta + Fattura + Riapri', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const ricevuta = await screen.findByRole('link', { name: /Ricevuta/ });
    expect(ricevuta).toHaveAttribute('href', expect.stringContaining('/api/pagamenti/ricevuta?pagamento_id=pg1'));
    expect(screen.getByTestId('fattura-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riapri/ })).toBeInTheDocument();
    // niente suggerimenti/ricerca sui confermati
    expect(screen.queryByText(/Cerca un altro pagamento/)).toBeNull();
  });

  it('movimento confermato ma non ancora pagato → nota «a saldo avvenuto», niente ricevuta', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'parziale' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await waitFor(() => expect(screen.getByText(/a saldo avvenuto/i)).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Ricevuta/ })).toBeNull();
  });
});

/**
 * ─── IL DIALOG AVEVA GIÀ `fattura_stato` IN MANO, E LO BUTTAVA VIA ───────────
 *
 * La risposta di `/api/pagamenti/[id]` porta `stato` **e** `fattura_stato`: il
 * dialog ne teneva solo il primo, e montava `<FatturaButton pagamentoId userId />`
 * nudo. `FatturaButton` parte da `'non_richiesta'`, quindi diceva «Invia fattura»
 * anche su un pagamento già fatturato: chi lo premeva riceveva un 409 che non
 * spiega niente — o, con un intestatario diverso, passava per il ramo «altro
 * intestatario» e la guardia di idempotenza non c'entrava più.
 *
 * Qui si asserisce sulle PROPS ricevute, non sulla presenza di un segnaposto: è
 * l'unica forma in cui «non è stata passata una prop» è un test che fallisce.
 */
describe('MovimentoDialog — stato della fattura al pulsante', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
  const rispostaPagamento = (fattura_stato: string | null) =>
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

  it('fattura già emessa → il pulsante riceve fatturaStato="emessa" (non riparte da «non richiesta»)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    await waitFor(() => expect(spiaFattura.props.at(-1)?.fatturaStato).toBe('emessa'));
    expect(spiaFattura.props.at(-1)?.pagamentoId).toBe('pg1');
  });

  /**
   * ⚠️ «IN ATTESA SDI» NON HA UN PULSANTE, E NON DEVE AVERLO.
   *
   * In quello stato `FatturaButton` non rende un comando: rende un `Badge` con
   * una rotella che gira all'infinito e la stessa identica parola del chip di
   * stato — «In attesa SDI», scritta due volte a dieci pixel di distanza. Non è
   * premibile, non apre niente, e la rotella promette un aggiornamento che non
   * arriverà mai senza ricaricare la pagina: movimento gratuito su un doppione.
   * Lo stato lo dice il chip, una volta sola.
   */
  it('fattura in attesa SDI → nessun pulsante fattura (sarebbe il chip scritto due volte)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('in_attesa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText('In attesa SDI')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Caricamento/)).toBeNull());
    expect(screen.queryByTestId('fattura-button')).toBeNull();
    // …e il chip resta UNO: due «In attesa SDI» sarebbero il difetto di prima
    expect(screen.getAllByText('In attesa SDI')).toHaveLength(1);
  });

  it('dopo l’emissione la lista si aggiorna: onEmessa è agganciato a onDone', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(await screen.findByTestId('fattura-button'));
    expect(onDone).toHaveBeenCalled();
  });

  it('con la fattura già uscita lo si DICE, e si mostra il chip di stato', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(/Fattura già emessa per questo pagamento/)).toBeInTheDocument();
    // il chip — lo STESSO della riga della lista — dice lo stato in una parola
    expect(screen.getByText('Fatturata')).toBeInTheDocument();
  });

  /**
   * ⚠️ «GIÀ EMESSA» SU UNA FATTURA IN ATTESA ERA UNA FRASE FALSA.
   *
   * Il documento è partito verso lo SdI e la risposta non è arrivata: finché non
   * arriva non è emesso niente, e può ancora tornare indietro scartato. La stessa
   * riga per due stati diversi diceva a chi lavora che il lavoro era finito.
   */
  it('fattura in attesa → si dice che si ASPETTA, non che è già emessa', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('in_attesa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(/si attende la conferma/i)).toBeInTheDocument();
    expect(screen.queryByText(/già emessa/i)).toBeNull();
    expect(screen.getByText('In attesa SDI')).toBeInTheDocument();
  });

  it('fattura NON richiesta → si dice che il pagamento è saldato e la fattura manca', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    expect(screen.queryByText(/già emessa/i)).toBeNull();
    expect(screen.getByText(/non è ancora stata emessa/i)).toBeInTheDocument();
    expect(spiaFattura.props.at(-1)?.fatturaStato).toBe('non_richiesta');
    expect(screen.getByText('Da fatturare')).toBeInTheDocument();
  });

  /**
   * ⚠️ SU «SCARTATA» IL POPUP NON DICEVA NIENTE — un chip rosso e nessuna
   * istruzione. È l'unico stato in cui qualcuno DEVE rifare il lavoro: se la
   * schermata tace, la fattura resta non emessa e nessuna guardia lo impedisce.
   */
  it('fattura SCARTATA → si dice cosa fare (correggere e rinviare), non solo che è rossa', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('scartata'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    await waitFor(() => expect(spiaFattura.props.at(-1)?.fatturaStato).toBe('scartata'));
    expect(screen.queryByText(/già emessa/i)).toBeNull();
    expect(screen.getByText(/rinviala/i)).toBeInTheDocument();
    expect(screen.getByText('Scartata')).toBeInTheDocument();
  });

  it('risposta senza `fattura_stato` (server più vecchio) → si degrada, nessun crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    expect(spiaFattura.props.at(-1)?.fatturaStato).toBeUndefined();
    expect(screen.queryByText(/Fattura già emessa/)).toBeNull();
  });
});

/**
 * ─── LA FORMA DEL POPUP (2026-09-05) ─────────────────────────────────────────
 *
 * Difetti misurati sulle schermate del giro precedente, tutti dentro `[role=dialog]`:
 *  · il chip di stato parlava un'altra lingua rispetto a quello della riga;
 *  · la ✕ era 28×28 e «Ricevuta» 92×28 — sotto i 44px di WCAG 2.5.8;
 *  · «Invia fattura» era `text-kidville-muted` su bianco: 3,80:1, sotto AA, e con
 *    l'aria di un pulsante spento proprio dove sta l'azione della schermata;
 *  · in Alto Contrasto il popup era identico alla luce normale (nessuna àncora).
 */
describe('MovimentoDialog — forma, bersagli e àncore di stile', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
  const rispostaPagamento = (fattura_stato: string | null) =>
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

  it('il chip del popup è LO STESSO della riga, col filetto che lo stacca dalla carta', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByText('Fatturata');
    const chip = container.querySelector('.kv-recon-chip') as HTMLElement;
    expect(chip, 'il popup deve portare l’àncora `kv-recon-chip`, come la riga').toBeTruthy();
    // stessa pelle della riga…
    expect(chip.className).toContain('bg-kidville-white');
    expect(chip.className).toContain('text-kidville-green');
    expect(chip.className).toContain('kv-recon-chip--fatturata');
    // …più il filetto, che sulla card bianca è l'unica cosa che lo delimita
    expect(chip.className).toContain('border-current');
  });

  it('la ✕ è un bersaglio da 44px e non usa il grigio `muted` (3,80:1)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const chiudi = screen.getByRole('button', { name: 'Chiudi il movimento' });
    expect(chiudi.className).toContain('h-11');
    expect(chiudi.className).toContain('w-11');
    expect(chiudi.className).not.toContain('text-kidville-muted');
  });

  it('il pulsante fattura è avvolto da un contenitore che DICHIARA il tono', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    const guscio = container.querySelector('.kv-recon-azione-fattura') as HTMLElement;
    expect(guscio, 'senza il guscio la pelle del CTA non ha dove attaccarsi').toBeTruthy();
    expect(guscio.dataset.tono).toBe('da_fatturare');
    expect(guscio.contains(screen.getByTestId('fattura-button'))).toBe(true);
  });

  it('su una fattura già emessa il guscio dichiara «fatturata» (secondario, non CTA)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    expect((container.querySelector('.kv-recon-azione-fattura') as HTMLElement).dataset.tono).toBe('fatturata');
  });

  it('la card porta l’àncora `kv-recon-dialog` (senza, in Alto Contrasto non esiste)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByRole('dialog').className).toContain('kv-recon-dialog');
  });

  it('nessun `text-kidville-muted` e nessuna opacità di colore in tutto il popup', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await screen.findByText('Fatturata');
    expect(container.innerHTML).not.toContain('text-kidville-muted');
    // le superfici crema erano `bg-kidville-cream/60`: con l'alfa nel NOME della
    // classe, la regola HC `.bg-kidville-cream` non le raggiunge nemmeno.
    expect(container.innerHTML).not.toContain('bg-kidville-cream/');
  });

  it('causale e ordinante hanno un’etichetta, come nelle email di sollecito', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText('Causale')).toBeInTheDocument();
    // «Intestato a», non «Ordinante:»: è la parola che la stessa famiglia legge
    // nell'email di sollecito, e nessun altro occhiello della schermata porta i
    // due punti. Due nomi per lo stesso campo sono due campi, per chi legge.
    expect(screen.getByText('Intestato a')).toBeInTheDocument();
    expect(screen.queryByText(/Ordinante/)).toBeNull();
    expect(screen.getByText('Mario Rossi')).toBeInTheDocument();
  });

  /**
   * ─── IL RIQUADRO «DOCUMENTI» AVEVA DECISO DI NON DECIDERE ───────────────────
   *
   * Era una card bianca con un filetto `border-kidville-line` sul fondo bianco
   * del popup: un contenitore che non si legge. Chip, frase e pulsanti
   * sembravano galleggiare, e il filetto compariva solo come un'ombra incerta
   * lungo il bordo — l'unico elemento della schermata che non aveva scelto se
   * essere un contenitore.
   *
   * Si decide: è una superficie, come il riquadro della causale sopra. Stesso
   * crema PIENO, nessun filetto, e i due blocchi separati dallo spazio. Il crema
   * pieno non è un dettaglio: `bg-kidville-cream/50` avrebbe l'alfa DENTRO il
   * nome della classe, e la regola di Alto Contrasto `.bg-kidville-cream` non lo
   * raggiungerebbe — il riquadro resterebbe chiaro sulla card nera.
   */
  it('«Documenti» è una superficie crema come la causale, non un filetto che non si vede', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByText('Fatturata');
    const documenti = screen.getByText('Documenti').closest('section') as HTMLElement;
    expect(documenti, 'il blocco documenti deve essere una `section`').toBeTruthy();
    expect(documenti.className).toContain('bg-kidville-cream');
    expect(documenti.className).toContain('rounded-card');
    expect(documenti.className, 'o è una superficie o è un filetto: non tutti e due').not.toContain('border-kidville-line');
    // …e il riquadro della causale è la STESSA superficie: due blocchi gemelli,
    // separati dallo spazio e non da due trattamenti diversi.
    const causale = screen.getByText('Causale').closest('div') as HTMLElement;
    expect(causale.className).toContain('bg-kidville-cream');
    expect(container.innerHTML).not.toContain('bg-kidville-cream/');
  });

  /**
   * ─── LA ✕ ERA ALLINEATA A NIENTE ────────────────────────────────────────────
   *
   * Con l'occhiello sopra la cifra, la ✕ finiva otticamente in mezzo ai due:
   * allineata né all'uno né all'altra. L'occhiello è stato tolto — la finestra ha
   * già il suo titolo accessibile, e «Bonifico del 04/09/2026» dice cosa si sta
   * guardando meglio di «Movimento bancario» — e la ✕ vive ora nella STESSA riga
   * flex della cifra: l'allineamento non è più una misura da azzeccare, è una
   * conseguenza della struttura.
   */
  it('la ✕ sta sulla stessa riga della cifra (allineamento per struttura, non a occhio)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const cifra = screen.getByRole('heading', { name: /150,00/ });
    const chiudi = screen.getByRole('button', { name: 'Chiudi il movimento' });
    expect(cifra.parentElement).toBe(chiudi.parentElement);
    expect(cifra.parentElement?.className).toContain('items-center');
  });

  /**
   * ─── LA FINESTRA NON SI POTEVA SCORRERE, E IL CORPO NEMMENO ─────────────────
   *
   * `Modal` centra la card in un `fixed inset-0` e blocca lo scorrimento del
   * body (`document.body.style.overflow = 'hidden'`). La card non aveva né
   * altezza massima né `overflow`: su un movimento da abbinare — con l'elenco
   * dei suggerimenti e la ricerca manuale — il popup supera l'altezza del
   * telefono, e ciò che esce non si raggiunge in nessun modo. Non «si scorre
   * dentro il popup»: non si scorre affatto, e «Chiudi» resta fuori portata.
   *
   * Il tetto è in `dvh` e non in `vh`: su iOS `vh` conta anche la barra degli
   * indirizzi che poi si ritira, cioè misura una finestra che non c'è.
   */
  it('la card ha un tetto d’altezza e scorre: il piede resta raggiungibile', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const card = screen.getByRole('dialog');
    expect(card.className).toContain('overflow-y-auto');
    expect(card.className, 'il tetto va in dvh: su iOS vh misura una finestra che si ritira').toContain('dvh');
  });
});

/**
 * ─── IL POPUP NON DEVE PARLARE IN NOMI DI CHIAVE ─────────────────────────────
 *
 * Una chiave assente non fa esplodere niente: next-intl ne scrive il NOME. Nel
 * collaudo del giro precedente il riquadro della causale mostrava
 * «adminContabilita.movdlgCausale» e la frase di stato
 * «adminContabilita.movdlgFatturaDaEmettere»: la contabilità che parla in gergo
 * di programmazione. La sonda cammina sui nodi di testo e rifiuta la FORMA di una
 * chiave — camelCase, punto, camelCase, nessuno spazio.
 */
const CHIAVE_GREZZA_DLG = /^[a-z]+[A-Za-z0-9]*\.[a-zA-Z][A-Za-z0-9]*$/;

function testiDelPopup(radice: HTMLElement): string[] {
  const out: string[] = [];
  const cammina = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const s = (n.textContent ?? '').trim();
      if (s) out.push(s);
      return;
    }
    n.childNodes.forEach(cammina);
  };
  cammina(radice);
  return out;
}

describe('MovimentoDialog — nessuna chiave di catalogo a schermo', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato2: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
  const conFattura = (fattura_stato: string | null) =>
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

  it('la sonda riconosce una chiave grezza e non scambia per tale una frase italiana', () => {
    // CONTROPROVA: un regex sbagliato direbbe «nessuna chiave» anche su una schermata piena.
    expect(CHIAVE_GREZZA_DLG.test('adminContabilita.movdlgCausale')).toBe(true);
    expect(CHIAVE_GREZZA_DLG.test('Causale')).toBe(false);
    expect(CHIAVE_GREZZA_DLG.test('Fattura già emessa per questo pagamento.')).toBe(false);
  });

  it('sul movimento da fatturare: occhielli e frase di stato sono in italiano', async () => {
    vi.stubGlobal('fetch', conFattura('non_richiesta'));
    const { container } = render(<MovimentoDialog movimento={confermato2} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await screen.findByText('Da fatturare');

    expect(testiDelPopup(container).filter((s) => CHIAVE_GREZZA_DLG.test(s))).toEqual([]);
    expect(screen.getByText('Causale')).toBeInTheDocument();
    expect(screen.getByText('Documenti')).toBeInTheDocument();
    expect(screen.getByText('Pagamento saldato: la fattura non è ancora stata emessa.')).toBeInTheDocument();
  });

  it('sul movimento da abbinare (suggerimenti + ricerca) nessuna chiave scappa', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(testiDelPopup(container).filter((s) => CHIAVE_GREZZA_DLG.test(s))).toEqual([]);
  });
});

/**
 * ─── IL RITMO DEL POPUP STA SULLA SCALA 4/8 ──────────────────────────────────
 *
 * Il popup mescolava `p-3.5` / `mb-3.5` / `pt-3.5` (14px) e `mt-1.5` (6px) con
 * `mb-3` (12) e `mt-4` (16): quattro valori, due dei quali a mezzo passo, in un
 * componente solo. I 26px risparmiati in altezza erano presi rompendo il ritmo
 * invece che togliendo un blocco.
 *
 * L'unica mezza misura ammessa resta `gap-1.5`, che non è un passo di layout ma
 * lo spazio fra un glifo e la sua parola.
 */
describe('MovimentoDialog — spaziature sulla scala 4/8', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato3: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };

  /**
   * Si guardano i CONTENITORI, non i comandi: il padding interno di una pillola
   * (`py-2.5`) è la specifica del bottone, condivisa con tutta l'area contabile
   * (`pagamenti/ui.ts`), mentre lo spazio FRA i blocchi è il ritmo di questa
   * schermata — ed è quello che era andato a 14 e 6 pixel.
   */
  const MEZZO_PASSO = /^-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\d*\.5$/;
  const spaziatureDeiContenitori = (radice: HTMLElement): string[] =>
    [...radice.querySelectorAll<HTMLElement>('*')]
      .filter((e) => !['BUTTON', 'A', 'INPUT', 'SVG'].includes(e.tagName.toUpperCase()))
      .flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/))
      .filter((c) => MEZZO_PASSO.test(c));

  it('nessun mezzo passo nelle spaziature, salvo il gap fra glifo e parola', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/pagamenti/pg1')
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: 'emessa' } }) }
      : { ok: true, status: 200, json: async () => ({ success: true }) })));
    const { container } = render(<MovimentoDialog movimento={confermato3} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await screen.findByText('Fatturata');

    const mezzi = spaziatureDeiContenitori(container).filter((c) => c !== 'gap-1.5');
    // CONTROPROVA del filtro: la sonda pesca davvero le classi a mezzo passo.
    const finto = document.createElement('div');
    finto.innerHTML = '<div class="p-3.5"><span class="mt-1.5">x</span></div>';
    expect(spaziatureDeiContenitori(finto)).toEqual(['p-3.5', 'mt-1.5']);
    expect([...new Set(mezzi)], 'spaziature fuori dalla scala 4/8').toEqual([]);
  });

  it('i due riquadri gemelli hanno lo stesso respiro (p-4) e lo stesso stacco (mb-4)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/pagamenti/pg1')
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: 'emessa' } }) }
      : { ok: true, status: 200, json: async () => ({ success: true }) })));
    render(<MovimentoDialog movimento={confermato3} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await screen.findByText('Fatturata');

    const causale = screen.getByText('Causale').closest('div') as HTMLElement;
    const documenti = screen.getByText('Documenti').closest('section') as HTMLElement;
    expect(causale.className).toContain('p-4');
    expect(causale.className).toContain('mb-4');
    expect(documenti.className).toContain('p-4');
  });
});

/**
 * ─── LO STATO SI LEGGE SULL'OCCHIELLO, NON IN FILA CON I COMANDI ─────────────
 *
 * Il chip «FATTURATA» stava sopra i due pulsanti, con la stessa pillola e lo
 * stesso filetto verde: tre oggetti uguali di cui uno solo non si preme. Adesso
 * sta sulla riga dell'occhiello — «DOCUMENTI … FATTURATA» — che è il posto in cui
 * uno stato si legge senza sembrare un comando.
 */
describe('MovimentoDialog — il chip di stato sta sull’occhiello', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato4: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };

  it('il chip condivide la riga con «Documenti», non la fila dei pulsanti', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/pagamenti/pg1')
      ? { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: 'emessa' } }) }
      : { ok: true, status: 200, json: async () => ({ success: true }) })));
    const { container } = render(<MovimentoDialog movimento={confermato4} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await screen.findByText('Fatturata');

    const occhiello = screen.getByText('Documenti');
    const chip = container.querySelector('.kv-recon-chip') as HTMLElement;
    expect(chip.parentElement, 'lo stato va accanto al titolo del riquadro').toBe(occhiello.parentElement);
    // …e non ha più la forma del pulsante che gli sta sotto
    expect(chip.className).toContain('rounded-md');
    expect(chip.className).not.toContain('rounded-pill');
    const ricevuta = screen.getByRole('link', { name: /Ricevuta/ });
    expect(ricevuta.className, 'i comandi restano pillole: la differenza di forma è il segnale').toContain('rounded-pill');
  });
});
