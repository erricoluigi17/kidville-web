import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog';
import type { MovimentoUi, PagamentoApertoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';

/**
 * IL TESTO CHE IL COMPONENTE RENDERÀ, RICAVATO COME LO RICAVA `test/setup.ts`.
 *
 * Il mock globale di next-intl risolve una chiave contro `messages/it/<ns>.json` e,
 * quando la chiave NON c'è, ripiega sul suo stesso nome (`adminContabilita.chiave`).
 * Asserire sulla prosa italiana scritta a mano legherebbe questo file al momento in
 * cui il catalogo viene aggiornato — che è un altro lavoro, su un altro file — e
 * renderebbe rosso un test che non misura niente di rotto.
 *
 * Qui la tesi è un'altra e più forte: «il componente rende LA VOCE DI QUESTA CHIAVE».
 * Resta verde prima e dopo l'aggiornamento del catalogo, e diventa rossa se il
 * componente cambia chiave o smette di renderla — che è esattamente il difetto da
 * intercettare.
 */
const CATALOGO_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>;
const testo = (chiave: string): string => CATALOGO_IT[chiave] ?? `adminContabilita.${chiave}`;

/**
 * IL SORGENTE DEL COMPONENTE, per le prove che il DOM non può reggere.
 *
 * Se ne serve una sola: `safeArea`. È una prop booleana che `Modal` traduce in
 * `padding: max(1rem, env(safe-area-inset-*))` sul contenitore, e in jsdom quella
 * dichiarazione NON sopravvive — misurato: con e senza la prop il contenitore esce
 * con `getAttribute('style') === null` e `style.paddingTop === ''`, perché jsdom
 * scarta il valore `env(...)`. Una prova sul DOM sarebbe verde in tutti e due i
 * casi, cioè il classico lock che non può fallire.
 */
const SORGENTE_DIALOG = readFileSync(
  join(process.cwd(), 'src/components/features/admin/pagamenti/MovimentoDialog.tsx'),
  'utf8',
);

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

/**
 * IL PANNELLO «COMPONI IL PAGAMENTO» — lo stub REGISTRA LE PROPS.
 *
 * ⚠️ UNO STUB CHE RENDESSE UN SEGNAPOSTO SAREBBE VERDE CON E SENZA LA
 * CORREZIONE: il difetto che le prove in fondo a questo file intercettano è *una
 * prop non passata* (`alunniIniziali`), e `<ComposizioneBonifico movimentoId … />`
 * e `<ComposizioneBonifico … alunniIniziali={[…]} />` producono lo stesso `<div>`.
 * È la stessa ragione per cui lo stub di `FatturaButton`, qui sopra, le registra.
 *
 * Il mock non tocca nessuna prova esistente: il pannello si monta solo su
 * richiesta, e nessuna di quelle qui sotto lo apre.
 *
 * Lo stub porta anche la VIA D'USCITA del pannello — il «Chiudi» che dentro il
 * pannello vero chiama `onChiudi`. Senza un modo di premerla dal test, «che cosa
 * resta puntato quando si torna indietro» non si potrebbe misurare: è un difetto
 * che si vede solo RIAPRENDO.
 */
const spiaComponi = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/features/admin/pagamenti/ComposizioneBonifico', () => ({
  ComposizioneBonifico: (props: Record<string, unknown>) => {
    spiaComponi.props.push(props);
    return (
      <div data-testid="pannello-componi">
        <button type="button" onClick={() => (props.onChiudi as (() => void) | undefined)?.()}>
          FINTO torna indietro
        </button>
      </div>
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

  /**
   * ─── LA SEDE NELLA RICERCA MANUALE (P5b, 2026-09-26) ────────────────────────
   * Con i pagamenti aperti di più sedi nella stessa lista, due «Retta Ottobre»
   * dello stesso cognome possono stare a Giugliano e a Cesa: la riga deve dire
   * quale. Con una sede sola non si ripete.
   */
  it('con pagamenti aperti di più sedi ogni voce della ricerca manuale nomina la sua sede', () => {
    vi.stubGlobal('fetch', vi.fn());
    const dueSedi: PagamentoApertoUi[] = [
      { ...aperti[0], scuola_id: 'sc-giu', scuola_nome: 'Kidville Giugliano' },
      { ...aperti[1], scuola_id: 'sc-cesa', scuola_nome: null },
    ];
    render(<MovimentoDialog movimento={movBase} aperti={dueSedi} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/Tina Blu · Kidville Giugliano · Iscrizione/)).toBeInTheDocument();
    // nome non letto: il ripiego tradotto, mai l'uuid
    expect(screen.getByText(new RegExp(`Ugo Verdi · ${testo('reconFiltroSedeSenzaNome')} · Mensa Novembre`))).toBeInTheDocument();
    expect(screen.queryByText(/sc-cesa/)).toBeNull();
  });

  // Una voce SENZA `scuola_id` (colonna nullable) non ha una sede di cui manchi il
  // nome: dire «Sede senza nome» affermerebbe il falso. Si dice che non è riconosciuta.
  it('con più sedi, la voce senza sede NON diventa «Sede senza nome»', () => {
    vi.stubGlobal('fetch', vi.fn());
    const conOrfana: PagamentoApertoUi[] = [
      { ...aperti[0], scuola_id: 'sc-giu', scuola_nome: 'Kidville Giugliano' },
      { ...aperti[1], scuola_id: 'sc-cesa', scuola_nome: 'Kidville Cesa' },
      { id: 'pa3', descrizione: 'Retta Ottobre', importo: 90, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Ada', cognome: 'Neri' }, scuola_id: null, scuola_nome: null },
    ];
    render(<MovimentoDialog movimento={movBase} aperti={conOrfana} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    const riga = screen.getByText(/Ada Neri · .* · Retta Ottobre/);
    expect(riga.textContent).toContain(`Ada Neri · ${testo('reconFiltroSedeNonRiconosciuta')} · Retta Ottobre`);
    expect(riga.textContent).not.toContain(testo('reconFiltroSedeSenzaNome'));
  });

  it('con pagamenti aperti di una sede sola la voce NON ripete la sede', () => {
    vi.stubGlobal('fetch', vi.fn());
    const unaSede: PagamentoApertoUi[] = aperti.map((p) => ({ ...p, scuola_id: 'sc-giu', scuola_nome: 'Kidville Giugliano' }));
    render(<MovimentoDialog movimento={movBase} aperti={unaSede} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/Tina Blu · Iscrizione/)).toBeInTheDocument();
    expect(screen.queryByText(/Kidville Giugliano/)).toBeNull();
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

  /**
   * ─── UN SOLO DOCUMENTO NEL RIQUADRO, E LA RICEVUTA NON DEVE TORNARE ────────
   *
   * Questo caso si chiamava «Ricevuta + Fattura + Riapri» e pretendeva un'ancora
   * verso `GET /api/pagamenti/ricevuta`. La rotta è stata cancellata: quel link
   * oggi porterebbe a un 404. La prova non sparisce, si ribalta — l'assenza è ciò
   * che va inchiodato, altrimenti la cancellazione si disfa da sola alla prima
   * modifica di questo riquadro.
   */
  it('movimento confermato + pagamento pagato → Fattura + Riapri, e NESSUNA «Ricevuta»', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    // Ciò che DEVE esserci: senza questa metà, l'assenza qui sotto sarebbe verde
    // anche su un riquadro che non ha renderizzato niente.
    expect(await screen.findByTestId('fattura-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riapri/ })).toBeInTheDocument();
    // Ciò che NON deve esserci più: né la parola, né l'indirizzo.
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    expect(container.innerHTML).not.toContain('/api/pagamenti/ricevuta');
    // niente suggerimenti/ricerca sui confermati
    expect(screen.queryByText(/Cerca un altro pagamento/)).toBeNull();
  });

  it('movimento confermato ma non ancora pagato → la nota parla della sola FATTURA', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'parziale' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const confermato: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    // La chiave è cambiata da `movdlgRicevutaFatturaSaldo` a `movdlgFatturaSaldo`:
    // la frase vecchia prometteva «ricevuta e fattura», e la ricevuta non arriva più.
    await waitFor(() => expect(screen.getByText(testo('movdlgFatturaSaldo'))).toBeInTheDocument());
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    expect(container.innerHTML).not.toContain('/api/pagamenti/ricevuta');
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
 * ─── IL CHIP DEL POPUP PORTA IL NUMERO, COME QUELLO DELLA RIGA (2026-09-06) ──
 *
 * `MovimentoDialog` rende la STESSA etichetta della lista — `<ChipFatturazione
 * fat={fat} suCarta />`, `MovimentoDialog.tsx:389` — e da `b98ce58e` quell'etichetta
 * scrive il NUMERO del documento al posto del generico «Fatturata». Fino a oggi,
 * però, nessun test di questo file passava al popup dei `numeri`: `movBase` non ha
 * il campo `fattura`, quindi `chipFatturazione` ricadeva sempre sul ripiego, e
 * l'unica asserzione era su quello («Fatturata», più sopra). Il comportamento
 * annunciato da quel commit aveva copertura ZERO proprio qui.
 *
 * Non è il doppione di `RiconciliazionePanel-fattura.test.tsx`: là il chip nasce dal
 * GET dell'elenco, qui da `movimento.fattura` incrociato col dettaglio del pagamento
 * (`/api/pagamenti/[id]`). Stessa funzione, due strade — e questa non la guardava
 * nessuno.
 *
 * Il plurale è ICU (`reconFatturaEmessa`): su un pagamento ripartito su due quote la
 * parola «Fattura» non è brutta, è FALSA — i documenti sono due, e si vanno a cercare
 * in archivio uno per uno.
 */
describe('MovimentoDialog — il chip del popup dice QUALE documento', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  /** Il pagamento è saldato e fatturato: è la sola condizione in cui il chip nasce. */
  const pagamentoSaldatoEFatturato = () =>
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: 'emessa' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

  const conDocumenti = (numeri: string[]): MovimentoUi => ({
    ...movBase, stato: 'confermato', pagamento_id: 'pg1', fattura: { stato: 'emessa', numeri },
  });

  it('un documento → il popup ne scrive il NUMERO, non il generico «Fatturata»', async () => {
    vi.stubGlobal('fetch', pagamentoSaldatoEFatturato());
    render(<MovimentoDialog movimento={conDocumenti(['FPR 1947/26'])} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const chip = await screen.findByText('Fattura FPR 1947/26');
    // L'etichetta secca che il numero SOSTITUISCE non resta a schermo: sarebbe lo
    // stesso stato scritto due volte, e una delle due volte senza il dato utile.
    expect(screen.queryByText('Fatturata')).toBeNull();
    // ed è il chip del POPUP: forma quadra (`suCarta`), non la pillola della riga
    expect(chip.className).toContain('rounded-md');
    expect(chip.className).not.toContain('rounded-pill');
  });

  it('due documenti → «Fatture» al PLURALE, coi due numeri uniti da « · »', async () => {
    vi.stubGlobal('fetch', pagamentoSaldatoEFatturato());
    render(<MovimentoDialog movimento={conDocumenti(['FPR 1947/26', 'Asilo 2328/2026'])} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    // «Fattura» qui sarebbe falso: le quote fatturate sono due.
    const chip = await screen.findByText('Fatture FPR 1947/26 · Asilo 2328/2026');
    expect(chip.className).toContain('rounded-md');
    expect(screen.queryByText('Fatturata')).toBeNull();
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

  /**
   * ─── LA VOCE DELLA CODA NEL POPUP (consegna 2b, D5/D6/D7) ────────────────────
   *
   * D6: il chip della coda, dai dati della riga, accanto a quello di fatturazione. D7:
   * «Errore in coda» è il collegamento alla pagina «Coda fatture». D5: con una voce che
   * aspetta o parte il pulsante della fattura non c'è, e nemmeno il suo contenitore.
   *
   * ⚠️ OGNI ASSENZA VIENE DOPO IL CHIP DI FATTURAZIONE. Quello si rende solo a lettura
   * del pagamento finita, quando pulsante e contenitore si decidono; il chip della coda
   * invece c'è già al montaggio, prima della lettura, quando pulsante e contenitore
   * mancano comunque. Un'assenza ancorata a lui sarebbe verde anche senza la condizione
   * (`.claude/rules/test.md`, punto 3).
   */
  const inCoda = (coda_stato: MovimentoUi['coda_stato']): MovimentoUi => ({ ...confermato, coda_stato });
  const ancora = () => screen.findByText(testo('reconChipDaFatturare'));

  it('coda `in_invio` → il chip è un’etichetta sulla carta, senza collegamento', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    render(<MovimentoDialog movimento={inCoda('in_invio')} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await ancora();
    const chip = screen.getByTestId('coda-chip');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent(testo('fatChip_coda_in_invio'));
    expect(chip.className).toContain('kv-recon-chip');
    expect(chip.className).toContain('border-current');
    expect(chip.className).toContain('text-kidville-info-strong');
    expect(screen.queryByRole('link', { name: /Coda fatture/i })).toBeNull();
  });

  it('coda `errore` → «Errore in coda» è il collegamento alla pagina, e il pulsante riceve lo stato', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    render(<MovimentoDialog movimento={inCoda('errore')} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await ancora();
    const link = screen.getByRole('link', { name: testo('fatChip_coda_errore_link') });
    expect(link).toHaveAttribute('href', '/admin/coda-fatture');
    expect(link).toHaveAttribute('data-testid', 'coda-chip');
    expect(link.className).toContain('kv-recon-chip--coda-errore');
    expect(link.className).toContain('border-current');
    expect(link.className).toContain('min-h-6');
    // D5: su errore il posto del pulsante resta (dentro, FatturaButton rende il collegamento)
    expect(screen.getByTestId('fattura-button')).toBeInTheDocument();
    expect(spiaFattura.props.at(-1)?.codaStato).toBe('errore');
  });

  it('nessuna voce in coda → nessun chip della coda, e il pulsante riceve `codaStato: null`', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    render(<MovimentoDialog movimento={inCoda(null)} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await ancora();
    expect(screen.getByTestId('fattura-button')).toBeInTheDocument();
    expect(spiaFattura.props.at(-1)?.codaStato).toBeNull();
    expect(screen.queryByTestId('coda-chip')).toBeNull();
  });

  it('coda `in_coda` → niente pulsante e niente contenitore vuoto (D5)', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('non_richiesta'));
    const { container } = render(<MovimentoDialog movimento={inCoda('in_coda')} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await ancora();
    expect(screen.getByTestId('coda-chip')).toHaveTextContent(testo('fatChip_coda_in_coda'));
    expect(screen.queryByTestId('fattura-button')).toBeNull();
    // col pulsante vero il guscio resterebbe vuoto; col finto lo si vedrebbe pieno
    expect(container.querySelector('.kv-recon-azione-fattura')).toBeNull();
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
    // «Ordinante», senza i due punti: è CHI HA FATTO il bonifico. Non «Intestato a»,
    // che nel resto del prodotto (card del genitore, email di sollecito) è il
    // BENEFICIARIO del conto: il tester localizzazione (2026-09-05) ha trovato
    // l'inglese invertito («Payable to»). Nessun occhiello porta i due punti.
    expect(screen.getByText('Ordinante')).toBeInTheDocument();
    expect(screen.queryByText(/Ordinante:/)).toBeNull();
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
   *
   * ⚠️ LA TESI NON È CAMBIATA, L'ASSERZIONE SÌ — e non perché quella di prima
   * fosse diventata scomoda. Quella prova difendeva una cosa sola, «il piede
   * resta raggiungibile», e lo faceva per via INDIRETTA: se la card ha un tetto
   * e scorre, scorrendo prima o poi ci arrivi. Ora il piede è FUORI dall'area
   * che scorre, quindi la stessa tesi si può asserire dritta — ed è più forte,
   * perché non dipende più da quanto è lungo il contenuto. Cancellare
   * l'asserzione vecchia e basta l'avrebbe trasformata in decorazione: al suo
   * posto ce ne sono QUATTRO, e la quarta è quella che tiene morto il
   * `max-h-56` della lista impedendogli di rientrare da un'altra parte.
   */
  /**
   * Chi scorre, cercato per TOKEN di classe: `overflow-hidden` non è uno scroller.
   *
   * ⚠️ LE VARIANTI CONTANO. Ancorata a `^overflow`, questa sonda non vedeva
   * `lg:overflow-y-auto`: lo scorrimento annidato della lista rientrava da `lg` in
   * su — cioè proprio sul monitor grande per cui il popup è stato allargato — con
   * il gate tutto verde. Il prefisso di variante si consuma qui, non si ignora.
   */
  const SCROLLATORE = /^(?:[a-z0-9-]+:)*overflow(?:-[xy])?-(?:auto|scroll)$/;
  /**
   * …e la classe non è l'unica porta: su questa card lo `style` inline è già usato
   * (il `boxShadow`), quindi `style={{ overflowY: 'auto' }}` non è un'ipotesi di
   * scuola, è una via aperta accanto a quella sorvegliata.
   */
  const scorreInline = (e: HTMLElement): boolean =>
    [e.style.overflow, e.style.overflowY, e.style.overflowX].some((v) => /^(?:auto|scroll)$/.test(v ?? ''));
  const scrollatoriIn = (radice: HTMLElement): HTMLElement[] =>
    [...radice.querySelectorAll<HTMLElement>('*')].filter(
      (e) => (e.getAttribute('class') ?? '').split(/\s+/).some((c) => SCROLLATORE.test(c)) || scorreInline(e),
    );

  /**
   * I token di una FAMIGLIA di proprietà (`max-w-`, `max-h-`), spogliati della
   * variante responsive.
   *
   * ⚠️ `max-width` e `max-height` sono proprietà a ULTIMO-CHE-VINCE: asserire la
   * PRESENZA di `max-w-[95%]` non dice NIENTE sull'effetto, perché un `sm:max-w-lg`
   * rimesso accanto vince da `sm` in su e riporta il popup a 512px con l'asserzione
   * ancora verde. La variante si toglie proprio perché `sm:max-w-lg` deve contare:
   * è il difetto di partenza che rientra travestito.
   */
  const famiglia = (classi: string[], prefisso: string): string[] =>
    classi.map((c) => c.replace(/^(?:[a-z0-9-]+:)*/, '')).filter((c) => c.startsWith(prefisso));

  it('1/4 · la radice ha il tetto in `dvh` e NON scorre più: a scorrere è il corpo', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const card = screen.getByRole('dialog');
    const classi = card.className.split(/\s+/);
    expect(card.className, 'il tetto va in dvh: su iOS vh misura una finestra che si ritira').toContain('dvh');
    expect(card.className, 'la card ritaglia: se scorresse lei, testa e piede scorrerebbero con tutto il resto').toContain('overflow-hidden');
    expect(classi).not.toContain('overflow-y-auto');

    // ⚠️ LA LARGHEZZA È IL MOTIVO PER CUI QUESTO LAVORO ESISTE, e fino a qui non
    // la teneva nessuna delle quattro prove: difendevano tutte l'ALTEZZA. Rimettere
    // `max-w-md` sulla costante riporta il popup a 448px su un monitor da 2560 —
    // cioè il difetto di partenza, con il gate tutto verde.
    //
    // ⚠️ E NON BASTA CHIEDERE CHE `max-w-[95%]` CI SIA: un `toContain` è verde anche
    // con `sm:max-w-lg` scritto accanto, che da `sm` in su vince per ordine di CSS e
    // riporta la card a 512px. È successo davvero, ed è il motivo per cui questa riga
    // è stata riscritta: si asserisce l'INSIEME della famiglia — uno e uno solo — non
    // la presenza di un suo membro. Per TOKEN e non per sottostringa, perché un lock
    // che si accontenta di `includes` si lascia soddisfare da un commento.
    expect(
      famiglia(classi, 'max-w-'),
      'un secondo `max-w-*` vince per ordine di CSS e riporta il popup a 512px: di questa famiglia ce n’è uno solo',
    ).toEqual(['max-w-[95%]']);

    // ⚠️ E UN TETTO NON È UNA LARGHEZZA. La riga qui sopra dichiara di difendere
    // il 95%, ma `max-w-*` dice soltanto fin DOVE la card può arrivare: chi la
    // porta fin lì è `w-full`. Misurato: tolto `w-full` dalla costante, il file
    // resta verde 54/54 — la card è un figlio flex senza `flex-grow`, quindi si
    // dimensiona sul contenuto, e `max-w-[95%]` diventa un limite che non viene
    // mai raggiunto. Il popup non è più «quasi a tutto schermo», che è la
    // decisione da cui nasce tutto questo lavoro.
    // Stessa famiglia di difetto dello `sticky` più sotto: un token che resta
    // scritto ed è inerte perché gli è stato tolto il compagno.
    expect(
      classi,
      '`max-w-*` è un TETTO, non una larghezza: senza `w-full` la card si dimensiona sul contenuto e il 95% non lo raggiunge mai',
    ).toContain('w-full');

    // ⚠️ TOGLIERE IL CONTESTO FLEX È PEGGIO DEL DIFETTO DI PARTENZA, non un
    // arretramento: senza `flex flex-col` sulla card, il `min-h-0 flex-1` del corpo
    // non fa più niente (il corpo prende altezza `auto` e il suo `overflow-y-auto`
    // non genera nessuno scorrimento) e l'`overflow-hidden` qui sopra RITAGLIA VIA
    // il piede. «Chiudi» non torna «in fondo al rotolo»: diventa irraggiungibile,
    // senza nemmeno una rotella da girare. Le prove 2/4 e 4/4 restano verdi lo
    // stesso — la 2/4 guarda il FIGLIO, la 4/4 conta ancora un solo scroller — ed è
    // esattamente per questo che la tesi va asserita sul PADRE, qui.
    expect(
      classi,
      'senza contesto flex il `flex-1`/`min-h-0` del corpo non fa niente e l’`overflow-hidden` ritaglia via il piede',
    ).toEqual(expect.arrayContaining(['flex', 'flex-col']));

    // ⚠️ `max-h-full` È LA GUARDIA, e `h-[95dvh]` da solo soddisfa il `dvh` qui
    // sopra: senza, il lock non la copre. Con `safeArea` il contenitore di `Modal`
    // imbottisce di `max(1rem, env(safe-area-inset-*))` per lato, quindi lo spazio
    // vero è `100dvh − (inset sopra + inset sotto)`; su un telefono con notch e
    // barra di gesto quello spazio scende sotto il 95dvh chiesto dalla card, che
    // essendo centrata (`items-center`) sfora simmetricamente SOPRA e SOTTO — la ✕
    // sotto il notch, i pulsanti del piede sotto l'home indicator. Cioè le due cose
    // da cui si esce.
    //
    // ⚠️ STESSA TRAPPOLA DELLA LARGHEZZA, e qui morde più forte: `max-height` è a
    // ultimo-che-vince, quindi un `max-h-[calc(100dvh-2rem)]` rimesso accanto alla
    // guardia vince — ed è proprio il `calc` a mano che tutto il commento della
    // costante dichiara di aver ucciso, quello che sottrae 2rem fissi mentre con
    // `safeArea` l'imbottitura vera è `max(1rem, env(safe-area-inset-*))`. Cioè il
    // numero sbagliato torna in vigore esattamente nel caso per cui è sbagliato.
    expect(
      famiglia(classi, 'max-h-'),
      'la guardia è una sola: un secondo `max-h-*` vince per ordine di CSS, e il `calc` a mano è sbagliato proprio quando `safeArea` è attivo',
    ).toEqual(['max-h-full']);

    // …e la guardia presuppone `safeArea`. In jsdom la prop non lascia traccia nel
    // DOM (vedi `SORGENTE_DIALOG`), quindi si asserisce sul sorgente — con un'àncora
    // di riga intera e non con un `includes('safeArea')`: quel file nomina «safeArea»
    // anche nei propri commenti, e un lock che si immunizza da solo col proprio
    // commento è una trappola già pagata in questo repo.
    expect(
      SORGENTE_DIALOG,
      'senza `safeArea` la card al 95% finisce sotto il notch e sotto la barra di gesto',
    ).toMatch(/^\s*safeArea\s*$/m);
  });

  it('2/4 · il corpo è il pezzo che scorre, e `min-h-0` è ciò che glielo permette', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const classi = screen.getByTestId('movdlg-corpo').className.split(/\s+/);
    expect(
      classi,
      'senza `min-h-0` un figlio flex non si comprime sotto il proprio contenuto (`min-height: auto`): la fascia cresce e il corpo non scorre',
    ).toContain('min-h-0');
    expect(classi).toContain('flex-1');
    expect(classi).toContain('overflow-y-auto');
  });

  it('3/4 · il piede è FRATELLO del corpo, non un suo discendente: «Chiudi» non si scorre', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const corpo = screen.getByTestId('movdlg-corpo');
    const piede = screen.getByTestId('movdlg-piede');
    const testa = screen.getByTestId('movdlg-testa');
    expect(corpo.contains(piede), 'dentro il corpo il piede tornerebbe in fondo al rotolo: è il difetto di partenza').toBe(false);
    expect(piede.parentElement, 'testa, corpo e piede sono tre fratelli della stessa colonna flex').toBe(corpo.parentElement);
    expect(testa.parentElement).toBe(corpo.parentElement);
    // La cifra sta nella fascia fissa, non nel rotolo: è l'unica cosa che dice
    // QUANTO si sta incassando, e scorreva via al primo suggerimento.
    expect(testa.contains(screen.getByRole('heading', { name: /150,00/ }))).toBe(true);
    expect(corpo.contains(screen.getByRole('button', { name: 'Chiudi il movimento' }))).toBe(false);
    // «Chiudi», non «Chiudi il movimento»: sono due comandi diversi, e quello
    // del piede è l'unico che deve restare a vista senza scorrere.
    expect(piede.contains(screen.getByRole('button', { name: 'Chiudi' }))).toBe(true);

    // ⚠️ ESSERE FRATELLI NON BASTA: in una colonna flex il valore iniziale di
    // `flex-shrink` è 1, quindi il corpo — che cresce quanto vuole — comprime le
    // due fasce fisse invece di lasciarle intere. Senza `shrink-0` i pulsanti del
    // piede si schiacciano e la cifra della testa pure: restano dove sono, ma
    // alti pochi pixel, che è un altro modo di non poterli usare.
    expect(piede.className.split(/\s+/), 'senza `shrink-0` il corpo comprime il piede e i pulsanti si schiacciano').toContain('shrink-0');
    expect(testa.className.split(/\s+/), 'stessa cosa per la testa: la cifra e la ✕ si lasciano comprimere dal corpo').toContain('shrink-0');
  });

  it('4/4 · un solo scroller in tutto il popup: il `max-h-56` della lista non rientra da un’altra parte', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    // CONTROPROVA: senza, una sonda che non pesca più niente direbbe «tutto a posto».
    //
    // ⚠️ E LA CONTROPROVA SI ESERCITA IN TUTTE LE DIREZIONI IN CUI LA SONDA PUÒ
    // FALLIRE, non solo in quella in cui funziona. Con il solo token nudo qui dentro,
    // la sonda è stata verde mentre `lg:overflow-y-auto` e `style={{ overflowY }}`
    // le passavano accanto: tre nodi, tre vie diverse allo stesso difetto.
    const finto = document.createElement('div');
    finto.innerHTML =
      '<div class="max-h-56 space-y-1 overflow-y-auto"></div>' +
      '<div class="max-h-56 lg:overflow-y-auto"></div>' +
      '<div class="max-h-56" style="overflow-y: auto"></div>' +
      '<div class="overflow-hidden"></div>';
    expect(
      scrollatoriIn(finto),
      'la sonda pesca il token nudo, la VARIANTE e lo stile inline — e non l’`overflow-hidden`',
    ).toHaveLength(3);

    expect(
      scrollatoriIn(screen.getByRole('dialog')),
      'due rotelle sovrapposte: quella interna finisce e la pagina sotto sussulta',
    ).toEqual([screen.getByTestId('movdlg-corpo')]);
  });

  /**
   * ─── IL FATTO A SINISTRA, IL LAVORO A DESTRA ────────────────────────────────
   *
   * A 512px stava tutto in colonna: causale, avvisi, suggerimenti, il form di
   * composizione, la lista. Con la card quasi a tutto schermo le due cose si
   * separano — ciò che la banca ha mandato non si muove, ciò che si preme sta
   * dall'altra parte — e i due binari sono `minmax(0,…)` tutti e due: il minimo
   * implicito di una traccia è `auto`, quindi una causale lunghissima senza
   * spazi allargherebbe il binario invece di andare a capo.
   */
  it('a `lg` il corpo ha due binari, e sotto `lg` l’aside viene PRIMO senza nessun `order-*`', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const aside = screen.getByRole('complementary');
    const lavoro = screen.getByTestId('movdlg-lavoro');
    const griglia = aside.parentElement as HTMLElement;
    expect(lavoro.parentElement, 'le due colonne stanno nella stessa griglia').toBe(griglia);

    // ⚠️ I BINARI NON SONO LA GRIGLIA: `grid-template-columns` su un box che è
    // rimasto `display: block` è INERTE, e le due colonne tornano impilate senza
    // che nessuna di queste righe se ne accorga. Misurato: tolto il solo token
    // `grid` dal contenitore, il file resta verde 54/54 e il deliverable — FATTO
    // a sinistra, LAVORO a destra — sparisce.
    //
    // E si asserisce per TOKEN, non per sottostringa: `toContain('grid-cols-1')`
    // su una stringa è soddisfatto anche da un `lg:grid-cols-1` che di colonna
    // sola non ne ha nessuna. È la stessa lezione del `border-kidville-line` che
    // CONTIENE «order-», dieci righe più sotto.
    const classiGriglia = griglia.className.split(/\s+/);
    expect(
      classiGriglia,
      'senza `grid` il `grid-cols-*` è inerte: i binari non esistono e le colonne tornano una',
    ).toContain('grid');
    expect(classiGriglia).toContain('lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]');
    expect(classiGriglia, 'sotto `lg` è una colonna sola').toContain('grid-cols-1');
    expect(griglia.children[0], 'in colonna sola il FATTO si legge prima del lavoro').toBe(aside);

    // Lo `sticky` è la ragione dichiarata della colonna sinistra: la causale si
    // legge MENTRE si compone a destra, e prima scorreva via al primo
    // suggerimento. Senza `lg:sticky` le due colonne restano due, ma la sinistra
    // torna a sparire in alto — cioè il difetto si riapre con l'impaginazione
    // ancora giusta.
    //
    // ⚠️ E LO `STICKY` SI SPEGNE LASCIANDOLO SCRITTO, in due modi che il solo
    // `toContain('lg:sticky')` non vedeva: `position: sticky` con `top: auto` non si
    // incolla mai a niente, e un elemento di griglia è alto quanto la riga
    // (`align-items: stretch`), quindi senza `self-start` non ha nessun margine
    // entro cui scorrere. Sono i due motivi che il sorgente scrive accanto alle
    // classi: qui si asseriscono tutti e tre i token, non solo quello che dà il nome
    // alla tecnica.
    expect(
      aside.className.split(/\s+/),
      'lo sticky si spegne anche restando scritto: senza offset `top` non si incolla, e senza `self-start` la colonna è alta quanto la riga e non ha margine per scorrere',
    ).toEqual(expect.arrayContaining(['lg:sticky', 'lg:top-0', 'lg:self-start']));
    // `min-w-0` è la stessa tesi dei `minmax(0,…)` dei binari, un piano più giù:
    // il minimo implicito di un elemento di griglia è `auto`, quindi una riga
    // lunga senza spazi (una causale, un'etichetta) sfonda il binario `1fr`
    // invece di andare a capo. Quella dei binari è coperta qui sopra; questa no.
    expect(lavoro.className.split(/\s+/), 'senza `min-w-0` una riga lunga sfonda il binario `1fr` invece di andare a capo').toContain('min-w-0');

    // Le classi come TOKEN: `border-kidville-line` CONTIENE «order-», e un
    // `[class*="order-"]` scatterebbe su ogni filetto del popup.
    //
    // ⚠️ LE VARIANTI SONO IL RIORDINO, non un contorno: `order-*` nudo non lo
    // scrive nessuno, si scrive `max-lg:order-last`. Ancorata a `(?:[a-z]+:)?`
    // questa sonda era cieca proprio lì — `max-lg:` ha un trattino, `2xl:`
    // comincia per cifra, e il `?` ne ammetteva UNA sola, quindi le sfuggiva
    // anche `lg:hover:order-2`. Misurato: con `max-lg:order-last 2xl:order-2`
    // sull'`aside` il file restava verde 54/54 con l'`aside` visivamente ULTIMO
    // sotto `lg`, cioè esattamente ciò che questa prova dichiara di vietare.
    // Stessa cecità sul prefisso già corretta in `SCROLLATORE` e in `famiglia`:
    // il prefisso di variante si CONSUMA, e se ne consumano quanti ce ne sono.
    const riordinati = [...griglia.querySelectorAll<HTMLElement>('*')]
      .flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/))
      .filter((c) => /^(?:[a-z0-9-]+:)*-?order-/.test(c));
    expect(riordinati, 'un ordine visuale diverso da quello di tabulazione è un difetto di accessibilità (WCAG 1.3.2)').toEqual([]);
  });

  it('il FATTO e il LAVORO sono due regioni con un nome accessibile distinto', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const aside = screen.getByRole('complementary');
    const lavoro = screen.getByTestId('movdlg-lavoro');
    const nomeFatto = aside.getAttribute('aria-label') ?? '';
    const nomeLavoro = lavoro.getAttribute('aria-label') ?? '';
    // Un `aside` senza nome accessibile non è un landmark: è un contenitore, e
    // chi naviga per regioni non lo trova.
    expect(nomeFatto).not.toBe('');
    expect(nomeLavoro).not.toBe('');
    expect(nomeLavoro, 'due landmark con lo stesso nome non si distinguono').not.toBe(nomeFatto);
    expect(screen.getByRole('complementary', { name: nomeFatto })).toBe(aside);
    expect(screen.getByRole('region', { name: nomeLavoro })).toBe(lavoro);
  });

  /**
   * ─── DOVE IL LAVORO NON C'È, LE DUE COLONNE NON HANNO PIÙ UNA PREMESSA ──────
   *
   * Misurato sul render, non dedotto: su `stato: 'confermato'` la colonna di
   * destra usciva con `childElementCount = 0` e `innerHTML = ""`, sotto un
   * `aria-label` che dice «Abbina». Due guasti in uno.
   *
   * (a) Accessibilità: chi naviga per landmark trova una regione annunciata col
   *     nome di un comando, ci entra, e dentro non c'è niente. Un landmark vuoto
   *     è peggio di un landmark assente, perché promette.
   * (b) Impaginazione, ed è il paradosso: il binario `1fr` resta vuoto, quindi
   *     l'unico contenuto — causale, documenti — vive nei 22rem = 352px del
   *     binario sinistro, con mezzo schermo di vuoto accanto. Cioè PIÙ STRETTO
   *     dei ~472px che aveva nella card da 512px, dentro un popup che adesso è
   *     95dvh × 95%. Il popup è diventato enorme e il suo unico contenuto si è
   *     ristretto.
   *
   * Le altre prove di questo file usano `movBase` (`stato: 'suggerito'`), dove
   * `haLavoro` è vero e non cambia niente: questa è l'unica che guarda l'altro
   * ramo, ed è il ramo che nessuno guardava.
   */
  it('su un movimento confermato la colonna del LAVORO non esiste, e il FATTO prende tutta la larghezza', async () => {
    vi.stubGlobal('fetch', rispostaPagamento('emessa'));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByText('Fatturata');

    expect(screen.queryByTestId('movdlg-lavoro'), 'un `region` vuoto col nome di un comando che lì non c’è').toBeNull();
    expect(
      screen.queryByRole('region', { name: testo('movdlgAbbina') }),
      'e non deve restare nemmeno come landmark: chi naviga per regioni ci entrerebbe per trovare il vuoto',
    ).toBeNull();

    // Un solo binario: senza, il FATTO resterebbe nei 22rem del binario sinistro
    // con il `1fr` vuoto accanto — più stretto di com'era nella card da 512px.
    const aside = screen.getByRole('complementary');
    const griglia = aside.parentElement as HTMLElement;
    expect(griglia.className, 'niente secondo binario quando non c’è un secondo contenuto').not.toContain('lg:grid-cols-[');
    expect(griglia.className, 'resta una griglia a una colonna, non un’altra impaginazione').toContain('grid-cols-1');
    expect(griglia.children, 'il FATTO è rimasto l’unico figlio della griglia').toHaveLength(1);
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
    // Dal 2026-09-24 (consegna 2b, D6) sulla riga dell'occhiello gli stati sono due,
    // fatturazione e coda, dentro un contenitore che li porta a destra e a capo INSIEME:
    // la misura scende di un livello, la tesi no. Portati nella fila dei pulsanti, il
    // loro nonno sarebbe la `section` e non la riga dell'occhiello.
    expect(chip.parentElement?.parentElement, 'lo stato va accanto al titolo del riquadro').toBe(occhiello.parentElement);
    expect(chip.parentElement?.className, 'i chip dell’occhiello vanno a capo insieme').toContain('flex-wrap');
    // …e non ha più la forma del pulsante che gli sta sotto
    expect(chip.className).toContain('rounded-md');
    expect(chip.className).not.toContain('rounded-pill');
    /* LA TESI RESTA, IL COMANDO SU CUI SI MISURA NO. Qui si prendeva il link
       «Ricevuta» per dire che i comandi sono pillole e lo stato no: quel link non
       esiste più. Il confronto si sposta su un comando che c'è ancora — «Riapri»,
       che porta `BTN_SECONDARY` — perché la tesi non era «la ricevuta è una
       pillola», era «lo stato NON ha la forma di un comando», e per dirlo serve
       un comando qualunque nella stessa vista.
       NON si misura sul pulsante della fattura: lì la pillola arriva da
       `globals.css` (`.kv-recon-azione-fattura > button { border-radius: 9999px }`),
       che in jsdom non è caricato — e sotto c'è comunque il mock, non il
       componente vero. Sarebbe una prova che guarda il proprio finto. */
    const comando = screen.getByRole('button', { name: /Riapri/ });
    expect(comando.className, 'i comandi restano pillole: la differenza di forma è il segnale').toContain('rounded-pill');
    expect(screen.queryByText(/Ricevuta/i), 'la ricevuta non si scarica più da qui').toBeNull();
  });
});

/**
 * ─── DOPO L'EMISSIONE IL POPUP CONTINUAVA A DIRE «DA FATTURARE» (2026-09-06) ──
 *
 * Misurato dal collaudo frontend, in jsdom, col `FatturaButton` vero: appena
 * emessa la fattura il popup mostrava ancora il chip giallo «Da fatturare», la
 * frase «la fattura non è ancora stata emessa» e il pulsante dipinto da CTA —
 * a due centimetri dal badge «In attesa SDI» che il pulsante stesso aveva appena
 * mostrato. «GET dettaglio pagamento dopo emissione: 1»: mai riletto.
 *
 * CAUSA RADICE. `pagamentoStato`/`pagamentoFattura` sono stato LOCALE del dialog,
 * caricati una volta sola al montaggio; `onEmessa` era cablato dritto a `onDone`,
 * che ricarica la LISTA — e la lista non riscrive `selezionato`, cioè la prop da
 * cui il popup è nato. Il popup non aveva nessuna via per rileggere ciò che aveva
 * appena cambiato.
 *
 * ⚠️ QUESTE DUE PROVE VANNO IN COPPIA. La prima pretende la SECONDA lettura dopo
 * l'emissione; la seconda pretende che all'apertura ne resti UNA sola. Da sola, la
 * prima si accontenterebbe anche di un effetto che rilegge a ogni render — cioè di
 * un difetto peggiore di quello che chiude.
 */
describe('MovimentoDialog — dopo l’emissione il popup rilegge sé stesso', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; });

  const confermato5: MovimentoUi = { ...movBase, stato: 'confermato', pagamento_id: 'pg1' };

  /**
   * Il server visto dal popup: conta le letture del dettaglio e cambia risposta
   * quando l'emissione è avvenuta — che è ciò che succede davvero, perché la POST
   * della fattura scrive `pagamenti.fattura_stato` prima di chiamare `onEmessa`.
   */
  const serverDelPagamento = () => {
    const banco = { letture: 0, fattura: 'non_richiesta' };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pg1')) {
        banco.letture += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: banco.fattura } }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    return { banco, fetchMock };
  };

  it('emessa la fattura, il chip passa a «In attesa SDI» e la frase «da emettere» sparisce', async () => {
    const { banco, fetchMock } = serverDelPagamento();
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato5} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    // Punto di partenza: saldato, nessuna fattura → chip giallo e invito ad agire.
    expect(await screen.findByText('Da fatturare')).toBeInTheDocument();
    expect(screen.getByText(/non è ancora stata emessa/i)).toBeInTheDocument();

    // L'emissione riesce: il server ora risponde «in attesa SDI».
    banco.fattura = 'in_attesa';
    fireEvent.click(screen.getByTestId('fattura-button'));

    await waitFor(() => expect(
      banco.letture,
      'dopo l’emissione il popup deve rileggere il dettaglio del pagamento: senza, dice ancora «Da fatturare»',
    ).toBe(2));

    await waitFor(() => expect(screen.getByText('In attesa SDI')).toBeInTheDocument());
    expect(screen.queryByText('Da fatturare'), 'lo stato non può dirsi in due modi opposti').toBeNull();
    expect(screen.queryByText(/non è ancora stata emessa/i)).toBeNull();
    expect(screen.getByText(/si attende la conferma/i)).toBeInTheDocument();
    // …e la lista continua a ricaricarsi come prima: la rilettura si AGGIUNGE.
    expect(onDone).toHaveBeenCalled();
  });

  it('«in attesa SDI» toglie il pulsante-CTA: lo stato resta detto UNA volta', async () => {
    const { banco, fetchMock } = serverDelPagamento();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MovimentoDialog movimento={confermato5} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    // `waitFor` ritenta solo se il corpo LANCIA: un `querySelector` che torna
    // `null` passerebbe al primo giro. L'attesa sta nell'asserzione.
    await waitFor(() => expect(container.querySelector('.kv-recon-azione-fattura')).not.toBeNull());
    expect((container.querySelector('.kv-recon-azione-fattura') as HTMLElement).getAttribute('data-tono')).toBe('da_fatturare');

    banco.fattura = 'in_attesa';
    fireEvent.click(screen.getByTestId('fattura-button'));

    await waitFor(() => expect(
      container.querySelector('.kv-recon-azione-fattura'),
      'su «in attesa» il pulsante non esiste: restava un CTA giallo accanto al badge che dice il contrario',
    ).toBeNull());
    expect(screen.getAllByText('In attesa SDI')).toHaveLength(1);
  });


  it('aprire il popup costa UNA lettura sola: la rilettura è dell’emissione, non dell’apertura', async () => {
    const { banco, fetchMock } = serverDelPagamento();
    vi.stubGlobal('fetch', fetchMock);
    render(<MovimentoDialog movimento={confermato5} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByTestId('fattura-button');
    // Si aspetta un giro di eventi in più: un effetto che rilegge a ogni render
    // qui salirebbe a 2 anche senza che nessuno prema niente.
    await new Promise((r) => setTimeout(r, 50));
    expect(banco.letture, 'il dettaglio si legge una volta al montaggio').toBe(1);
  });
});

describe('MovimentoDialog — «questo bonifico sembra di un’altra sede»', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /**
   * ─── «QUESTO BONIFICO SEMBRA DI UN'ALTRA SEDE» ─────────────────────────────
   *
   * L'estratto conto è unico e i suggerimenti si calcolano su tutte le sedi, ma
   * la lista mostra a ogni segreteria solo i candidati della PROPRIA. Misurato in
   * produzione: 67 movimenti su 234 avevano l'aggancio forte altrove e candidati
   * locali deboli — cioè 67 righe che invitavano a registrare l'incasso sulla
   * voce di un bambino di un altro plesso.
   *
   * ⚠️ SI DECLASSA, NON SI NASCONDE. I candidati deboli restano e restano
   * premibili: nasconderli toglierebbe l'unica via d'uscita quando il segnale
   * sbaglia (un omonimo, un CF finito per errore in un'altra causale), e la
   * protezione vera esiste già — il PATCH respinge con 404 fuori sede. Cambia il
   * PESO VISIVO, che è ciò che rende facile l'errore.
   */
  const conAltraSede = (altra_sede: MovimentoUi['altra_sede']): MovimentoUi => ({ ...movBase, altra_sede });
  /** Le classi come TOKEN: `hover:text-kidville-white` contiene `text-kidville-white`. */
  const token = (el: Element) => el.className.split(/\s+/);

  it('con l’aggancio forte altrove: lo dice, e NOMINA la sede', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={conAltraSede({ nome: 'Kidville Cesa' })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/aggancio forte su Kidville Cesa/)).toBeInTheDocument();
    expect(screen.getByText(/sono deboli/)).toBeInTheDocument();
  });

  /**
   * ─── DUE CASI, DUE FRASI — E IL DOMINANTE ERA QUELLO SBAGLIATO ─────────────
   *
   * Il riquadro è appeso al solo verdetto, la lista dei candidati è dietro
   * `suggerimenti.length > 0`: le due condizioni NON coincidono, e a schermo
   * finiva una frase che parlava di «i suggerimenti qui sotto» sopra il vuoto.
   *
   * MISURATO in produzione il 2026-09-07 applicando la regola COME È IMPLEMENTATA
   * — sulle sole righe NON confermate — e contando i candidati che RESTANO dopo la
   * minimizzazione: dei 403 casi in cui il verdetto scatta, **332 hanno zero
   * candidati di casa** — Aversa 162 su 165, Cesa 162 su 166, Giugliano 8 su 72.
   * Per due segreterie su tre la frase era falsa quasi sempre: non c'è nessun
   * suggerimento «qui sotto», e non è «debole». (I «338 su 413» della prima
   * stesura erano PRIMA della guardia sulle confermate.)
   */
  it('con l’aggancio altrove e NESSUN candidato di casa: la frase è l’altra, e non parla di una lista che non c’è', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={{ ...conAltraSede({ nome: 'Kidville Cesa' }), suggerimenti: [] }} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/aggancio forte su Kidville Cesa/)).toBeInTheDocument();
    expect(screen.getByText(/si abbina dalla sede dell’aggancio/)).toBeInTheDocument();
    // la lista non è renderizzata: la frase che la nomina sarebbe una bugia
    expect(screen.queryByRole('button', { name: /Conferma questo/ })).toBeNull();
    expect(screen.queryByText(/sono deboli/), 'nessun suggerimento «qui sotto»').toBeNull();
  });

  it('con i candidati di casa resta la frase dei «deboli», e NON quella dell’altra sede', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={conAltraSede({ nome: 'Kidville Cesa' })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/sono deboli/)).toBeInTheDocument();
    expect(screen.queryByText(/si abbina dalla sede dell’aggancio/)).toBeNull();
  });

  it('senza il nome della sede: lo dice lo stesso, senza nominarla e senza inventare', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<MovimentoDialog movimento={conAltraSede({ nome: null })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.getByText(/aggancio forte su un’altra sede/)).toBeInTheDocument();
    // MAI un `null`, una graffa non sostituita o un segnaposto a schermo
    expect(container.textContent).not.toMatch(/null|\{sede\}|undefined/);
  });

  /**
   * ─── UN AVVISO NON PUÒ AVERE IL VESTITO DI CIÒ CHE INFORMA ─────────────────
   *
   * MISURATO sullo screenshot del 2026-09-07: il riquadro «Questo bonifico ha un
   * aggancio forte su Kidville Cesa» era la STESSA carta crema della card
   * «CAUSALE / ORDINANTE» che gli sta due centimetri sopra. Due rettangoli
   * identici: uno riporta dei dati, l'altro dice «se premi qui sotto registri
   * l'incasso sulla voce di un bambino di un altro plesso».
   *
   * Il peso arriva da tre cose, non dal fondo: un FILETTO laterale, un GLIFO e
   * l'INCHIOSTRO d'avviso. Il fondo resta crema apposta — `warn-soft` (#FBEFE2)
   * e crema (#FEF1E4) distano tre punti per canale, quindi cambiarlo non avrebbe
   * separato niente, e avrebbe portato fuori dalla regola di Alto Contrasto che
   * il popup ha già su `.bg-kidville-cream`.
   *
   * ⚠️ FONDI PIENI, MAI OPACITÀ TAILWIND (`/70`, `/80`): con l'alfa dentro il
   * nome della classe la regola HC `.kv-recon-dialog .bg-kidville-cream` non lo
   * raggiungerebbe nemmeno — è la lezione già scritta due volte in questo file.
   */
  it('l’avviso non ha il vestito della card che informa: filetto, glifo e inchiostro d’avviso', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={conAltraSede({ nome: 'Kidville Cesa' })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const titolo = screen.getByText(/aggancio forte su Kidville Cesa/);
    const avviso = titolo.closest('section') as HTMLElement;
    expect(avviso, 'il riquadro dell’altra sede è una <section> sua').not.toBeNull();
    const classi = token(avviso);

    // L'àncora dell'Alto Contrasto: senza, in HC il filetto e l'inchiostro non si
    // possono ridipingere e il riquadro torna indistinguibile dal suo vicino.
    expect(classi, 'manca la classe àncora per la regola di globals.css').toContain('kv-recon-avviso-sede');
    // Il filetto laterale, che è ciò che lo stacca a colpo d'occhio.
    expect(classi).toContain('border-kidville-warn-strong');
    expect(classi.some((c) => /^border-l(-|$)/.test(c)), 'il filetto è LATERALE').toBe(true);
    // Fondo PIENO: nessuna classe con l'alfa dentro il nome.
    expect(classi.filter((c) => c.includes('/')), 'niente opacità Tailwind su questo riquadro').toEqual([]);
    // Un glifo, che si legge prima del testo.
    expect(avviso.querySelector('svg'), 'manca il glifo d’avviso').not.toBeNull();
    // E l'inchiostro d'avviso sul titolo: #A64F09 su crema #FEF1E4 = 5,05:1 (AA).
    expect(token(titolo)).toContain('text-kidville-warn-strong');
  });

  it('la card che INFORMA resta quella di sempre: l’avviso non ha contagiato il vicino', () => {
    // Senza questa riga la prova qui sopra sarebbe verde anche se si fosse messo
    // il filetto d'avviso a TUTTI i riquadri crema del popup — cioè se si fosse
    // tolta di nuovo la differenza, dall'altro capo.
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<MovimentoDialog movimento={conAltraSede({ nome: 'Kidville Cesa' })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    const cartaCausale = container.querySelector('.mb-4.rounded-card.bg-kidville-cream') as HTMLElement;
    expect(cartaCausale, 'la card della causale non è più riconoscibile').not.toBeNull();
    expect(token(cartaCausale)).not.toContain('border-kidville-warn-strong');
    expect(token(cartaCausale)).not.toContain('kv-recon-avviso-sede');
  });

  it('senza verdetto (o a `null`) nessun riquadro: la schermata di sempre', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { unmount } = render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.queryByText(/aggancio forte/)).toBeNull();
    unmount();
    render(<MovimentoDialog movimento={conAltraSede(null)} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    expect(screen.queryByText(/aggancio forte/)).toBeNull();
  });

  it('i candidati deboli RESTANO e restano premibili, ma il CTA passa a secondario contornato', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MovimentoDialog movimento={conAltraSede({ nome: 'Kidville Cesa' })} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    const bottoni = screen.getAllByRole('button', { name: /Conferma questo/ });
    expect(bottoni, 'i suggerimenti non si nascondono: è l’unica via d’uscita se il segnale sbaglia').toHaveLength(2);
    for (const b of bottoni) {
      expect(token(b), 'secondario contornato').toContain('border-kidville-green');
      // A RIPOSO niente verde pieno — ma il TOKEN, non la sottostringa: il vestito
      // porta `hover:text-kidville-white`, che è il puntatore sopra, non il riposo.
      expect(token(b), 'niente più verde pieno a riposo').not.toContain('text-kidville-white');
      expect(token(b), 'niente più fondo verde pieno a riposo').not.toContain('bg-kidville-green');
    }
    // e si premono davvero: il declassamento è visivo, non funzionale
    fireEvent.click(bottoni[0]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('senza verdetto i CTA restano verdi pieni (il declassamento non è il default)', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    for (const b of screen.getAllByRole('button', { name: /Conferma questo/ })) {
      expect(token(b)).toContain('text-kidville-white');
      expect(token(b)).toContain('bg-kidville-green');
      expect(token(b)).not.toContain('border-kidville-green');
    }
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNA CASELLA SOLA, DUE GRUPPI — e la strada che sul rosso non esisteva.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Il filtro sulle VOCI APERTE è locale e istantaneo, ed è il 90% del lavoro: non
 * deve rallentare perché accanto è comparso un secondo gruppo. Il gruppo
 * «Bambini» passa dalla rotta, con soglia e debounce, e serve al caso che nel
 * primo non può comparire mai — il bambino che una voce aperta non ce l'ha.
 *
 * ⚠️ LE TRE COSE CHE UNA RICERCA NON PUÒ TACERE, e che qui sono asserite una per
 * una: la SOGLIA (sotto i due caratteri non parte niente, e si dice perché), il
 * TRONCAMENTO (un elenco tagliato che tace fa concludere «quel bambino non c'è»)
 * e il GUASTO (che non è un elenco vuoto: «non l'ho trovato» e «non ho potuto
 * guardare» hanno rimedi opposti).
 */
describe('MovimentoDialog — la ricerca dei bambini nel popup', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; spiaComponi.props.length = 0; });

  const ALUNNO = 'a1b2c3d4-0000-4000-8000-000000000001';

  /** Una risposta della rotta `…/riconciliazione/alunni`, nella sua forma vera. */
  const rispostaAlunni = (over: Record<string, unknown> = {}) => ({
    success: true,
    data: [
      {
        alunno_id: ALUNNO,
        nome: 'Primo Bambino',
        classe_sezione: '1A',
        scuola_id: 's1',
        attivo: true,
        voci_aperte: 0,
        residuo_aperto: 0,
        ha_pagante: true,
        trovato_per_cf: false,
      },
    ],
    troncato: false,
    sedi: { s1: 'Sede di prova' },
    ...over,
  });

  const reteConRicerca = (corpo: unknown, status = 200) => {
    const chiamate: string[] = [];
    const fn = vi.fn(async (url: string) => {
      if (String(url).includes('/riconciliazione/alunni')) {
        chiamate.push(String(url));
        return { ok: status < 400, status, json: async () => corpo };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    return { fn, chiamate };
  };

  const cerca = (valore: string) =>
    fireEvent.change(screen.getByLabelText(/Cerca un pagamento aperto/), { target: { value: valore } });

  it('sotto i due caratteri non chiama la rete, e la regione viva dice perché', async () => {
    // Non è un'ottimizzazione: `%a%` su tre plessi è l'intero registro letto per
    // una lettera battuta per sbaglio. Il silenzio, però, si spiega.
    const { fn, chiamate } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('a');

    await waitFor(() => expect(screen.getByTestId('movdlg-ricerca-stato')).toHaveTextContent(/almeno 2/));
    // ⚠️ UN `data-testid` NON DISTINGUE UNA REGIONE VIVA DA UN PARAGRAFO QUALUNQUE:
    // tolti gli attributi da quel `<p>` — lasciando tutto il resto — sessantasei
    // prove restavano verdi mentre l'elenco cambiava in silenzio per chi non vede
    // lo schermo. Qui si asserisce che quell'elemento È la regione viva.
    //
    // ⚠️ `aria-live` + `aria-atomic` E NON `role="status"`, che è quello che c'era
    // fino al 2026-09-20: per un lettore di schermo sono la stessa cosa, ma lo
    // `status` di questa superficie è UNO ed è la barra di quadratura del
    // pannello, che con la composizione aperta sta a schermo INSIEME a questa
    // casella. Quella coppia questo file non può vederla — qui
    // `ComposizioneBonifico` è uno stub — e la prova che la guarda sta in
    // `ComposizioneBonifico-dall-alunno.test.tsx`, che monta i due veri.
    const vivo = screen.getByTestId('movdlg-ricerca-stato');
    expect(vivo, 'la riga di stato è la regione viva').toHaveAttribute('aria-live', 'polite');
    expect(vivo).toHaveAttribute('aria-atomic', 'true');
    expect(screen.queryAllByRole('status'), 'col pannello chiuso non c’è nessuno `status`').toHaveLength(0);
    expect(chiamate, 'nessuna richiesta sotto la soglia').toHaveLength(0);
    // …e il filtro locale sulle voci aperte ha lavorato lo stesso, all'istante.
    expect(screen.getByText('Voci aperte')).toBeInTheDocument();
  });

  it('da due caratteri in su cerca davvero, e mostra il bambino senza nessuna voce aperta', async () => {
    const { fn, chiamate } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    await screen.findByText('Primo Bambino');
    expect(chiamate.at(-1), 'il termine viaggia nella query').toContain('q=primo');
    // È il motivo per cui questo gruppo esiste: nel primo non potrebbe comparire.
    expect(screen.getByText(/Nessuna voce aperta/)).toBeInTheDocument();
    expect(screen.getByTestId('movdlg-ricerca-stato')).toHaveTextContent(/1 bambino trovato/);
  });

  it('ELENCO TRONCATO: si scrive. Un elenco tagliato che tace fa concludere «non c’è»', async () => {
    const { fn } = reteConRicerca(rispostaAlunni({ troncato: true }));
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    await screen.findByText('Primo Bambino');
    await waitFor(() =>
      expect(screen.getByTestId('movdlg-ricerca-stato'), 'il troncamento è un DATO, non un dettaglio')
        .toHaveTextContent(/troncato/i),
    );
  });

  it('una ricerca FALLITA non diventa un elenco vuoto: stato suo, frase sua', async () => {
    const { fn } = reteConRicerca({ error: 'no', codice: 'CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA' }, 500);
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    const avviso = await screen.findByRole('alert');
    expect(avviso.textContent ?? '').not.toBe('');
    expect(screen.getByTestId('movdlg-ricerca-stato')).toHaveTextContent(testo('reconRicercaAlunniNonRiuscita'));
    // …e non si traveste da «non l'ho trovato».
    expect(screen.queryByText(testo('reconRicercaAlunniVuoto'))).toBeNull();
  });

  it('«Componi per questo bambino» monta il pannello con `alunniIniziali` NON VUOTO', async () => {
    // ⚠️ È LA PROVA CHE CHIUDE IL DIFETTO DAL LATO DEL POPUP. La spia guarda le
    // PROPS: uno stub che rendesse un segnaposto sarebbe verde anche se la prop
    // non partisse — e senza quella prop il pannello si apre sul contesto vuoto,
    // cioè col pulsante «Conferma» spento e nessuna strada per accenderlo.
    const { fn } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(testo('movdlgComponiPerQuesto')) }));

    expect(screen.getByTestId('pannello-componi')).toBeInTheDocument();
    expect(spiaComponi.props.at(-1)).toMatchObject({ movimentoId: 'm1', alunniIniziali: [ALUNNO] });
  });

  it('senza quel gesto il pannello non nasce aperto, e `alunniIniziali` resta vuoto', () => {
    // La composizione si carica da sé (contesto, figli, categorie, pacchetti):
    // montarla sempre vorrebbe dire pagare quella lettura su ogni riga aperta.
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(screen.queryByTestId('pannello-componi')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    expect(spiaComponi.props.at(-1)).toMatchObject({ alunniIniziali: [] });
  });

  it('TORNATO INDIETRO, il bersaglio si azzera: il pulsante generico riapre PULITO', async () => {
    // ⚠️ IL PERICOLO SCRITTO IN `componiPerAlunno`, RIENTRATO DA UN'ALTRA PORTA:
    // «un elenco che cresce a ogni click farebbe comporre su bambini scelti tre
    // ricerche fa, senza che si veda». Qui l'elenco non cresce — RESTA: aperto il
    // pannello su un bambino e chiuso tornando indietro, «Componi il pagamento»
    // lo riapriva ancora puntato su di lui, e a schermo non c'era niente che lo
    // dicesse. Non si scrive nulla di sbagliato (`?alunni=` ALLARGA il contesto),
    // ma il pannello non nasce nello stato che l'operatrice ha chiesto.
    const { fn } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(testo('movdlgComponiPerQuesto')) }));
    expect(spiaComponi.props.at(-1)).toMatchObject({ alunniIniziali: [ALUNNO] });

    // Indietro: il pannello se ne va, e con lui il bersaglio.
    fireEvent.click(screen.getByRole('button', { name: /FINTO torna indietro/ }));
    expect(screen.queryByTestId('pannello-componi')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    expect(screen.getByTestId('pannello-componi')).toBeInTheDocument();
    expect(spiaComponi.props.at(-1), 'riaperto dal pulsante generico, non punta più a nessuno')
      .toMatchObject({ alunniIniziali: [] });
  });

  /**
   * ─── `voci_aperte: null` NON È ZERO ──────────────────────────────────────
   *
   * 🔴 La regola era scritta in rosso nei commenti di DUE file e non la teneva
   * ferma nessun test: sostituito il ramo `null` con «Nessuna voce aperta» —
   * cioè fatta dire alla schermata esattamente la bugia che il commento vieta —
   * settantun prove restavano verdi. «Non ho potuto contare» e «non deve niente»
   * portano a due gesti opposti di chi sta incassando, e il secondo travestito da
   * primo chiude un movimento su una famiglia che ha ancora un debito aperto.
   *
   * Stessa prova per `attivo: false` e `trovato_per_cf`, che erano codice mai
   * eseguito da nessun test: le due fixture dichiaravano sempre valori pieni.
   * La funzione adesso è UNA (`use-ricerca-alunni`), quindi questa prova copre
   * anche il pannello di composizione.
   */
  it('`voci_aperte: null` NON È ZERO: si scrive «non verificate», mai «nessuna voce aperta»', async () => {
    const { fn } = reteConRicerca(
      rispostaAlunni({
        data: [
          {
            alunno_id: ALUNNO,
            nome: 'Primo Bambino',
            classe_sezione: '1A',
            scuola_id: 's1',
            // Non più iscritto: la riga NON sparisce, si incassa anche un arretrato.
            attivo: false,
            // `null` = «non ho potuto contare», e la rotta lo dichiara.
            voci_aperte: null,
            residuo_aperto: null,
            ha_pagante: true,
            trovato_per_cf: true,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    const riga = await screen.findByText('Primo Bambino');
    expect(riga).toHaveTextContent(testo('reconRicercaAlunniVociIgnote'));
    // 🔴 L'ASSENZA È LA META DELLA PROVA: senza questa riga il ramo `null`
    // potrebbe scrivere «Nessuna voce aperta» e restare verde.
    expect(screen.queryByText(new RegExp(testo('reconRicercaAlunniNessunaVoce')))).toBeNull();
    // …e le due note che oggi nessun test eseguiva.
    expect(riga).toHaveTextContent(testo('reconRicercaAlunniRitirato'));
    expect(riga).toHaveTextContent(testo('reconRicercaAlunniPerCf'));
  });

  it('CONTROPROVA · con `voci_aperte: 0` la frase è l’altra, e «non verificate» non c’è', async () => {
    // Senza questa metà, la prova qui sopra passerebbe anche se il codice dicesse
    // «non verificate» SEMPRE — cioè con i due rami collassati in uno.
    const { fn } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    const riga = await screen.findByText('Primo Bambino');
    expect(riga).toHaveTextContent(testo('reconRicercaAlunniNessunaVoce'));
    expect(screen.queryByText(new RegExp(testo('reconRicercaAlunniVociIgnote')))).toBeNull();
    // La fixture di base è iscritto e trovato per nome: nessuna delle due note.
    expect(riga).not.toHaveTextContent(testo('reconRicercaAlunniRitirato'));
    expect(riga).not.toHaveTextContent(testo('reconRicercaAlunniPerCf'));
  });

  /**
   * ─── CLASSE E PLESSO, E LA SOGLIA CHE DECIDE SE IL PLESSO SI SCRIVE ───────
   *
   * 🔴 IN QUESTO REPO LE SEDI DI PRODUZIONE SONO TRE, e il plesso è ciò che
   * distingue due «Rossi» omonimi PRIMA che si scriva un incasso. Erano due
   * delle quattro cose che la riga deve portare, e non le teneva ferme niente:
   * tutte le fixture avevano UNA sede sola, quindi il ramo del plesso era codice
   * morto per la suite e `classe_sezione` non era mai asserito. Tre mutazioni
   * sopravvivevano: soglia `> 1` abbassata a `> 0` (il plesso scritto anche
   * quando è uno solo, cioè la stessa parola su ogni riga), plesso tolto del
   * tutto, classe e plesso tolti insieme.
   *
   * Le due prove qui sotto sono la coppia — con due sedi il plesso c'è, con una
   * NON c'è — ed è la seconda a tenere ferma la soglia.
   */
  const ALUNNO_ALTRA_SEDE = 'a1b2c3d4-0000-4000-8000-000000000002';

  /** Due omonimi in due plessi: il caso per cui la colonna del plesso esiste. */
  const dueOmonimiDueSedi = {
    success: true,
    data: [
      {
        alunno_id: ALUNNO,
        nome: 'Rossi Ada',
        classe_sezione: '1A',
        scuola_id: 's1',
        attivo: true,
        voci_aperte: 0,
        residuo_aperto: 0,
        ha_pagante: true,
        trovato_per_cf: false,
      },
      {
        alunno_id: ALUNNO_ALTRA_SEDE,
        nome: 'Rossi Ivo',
        classe_sezione: '2B',
        scuola_id: 's2',
        attivo: true,
        voci_aperte: 0,
        residuo_aperto: 0,
        ha_pagante: true,
        trovato_per_cf: false,
      },
    ],
    troncato: false,
    sedi: { s1: 'Sede di prova', s2: 'Seconda sede' },
  };

  it('PIÙ SEDI: su ogni riga si scrive il plesso, o due omonimi sono indistinguibili', async () => {
    const { fn } = reteConRicerca(dueOmonimiDueSedi);
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('rossi');

    const prima = await screen.findByText('Rossi Ada');
    expect(prima).toHaveTextContent('1A');
    expect(prima, 'senza il plesso i due omonimi sono la stessa riga').toHaveTextContent('Sede di prova');

    const seconda = screen.getByText('Rossi Ivo');
    expect(seconda).toHaveTextContent('2B');
    expect(seconda).toHaveTextContent('Seconda sede');
  });

  it('CONTROPROVA · con UNA sola sede il plesso NON si scrive: sarebbe la stessa parola ovunque', async () => {
    // Senza questa metà, «scrivi sempre il plesso» passerebbe: è la riga che
    // tiene ferma la soglia `Object.keys(sedi).length > 1`.
    const { fn } = reteConRicerca(rispostaAlunni());
    vi.stubGlobal('fetch', fn);
    render(<MovimentoDialog movimento={movBase} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    cerca('primo');

    const riga = await screen.findByText('Primo Bambino');
    expect(riga, 'la classe si scrive sempre').toHaveTextContent('1A');
    expect(riga, 'con un plesso solo il suo nome è rumore su ogni riga').not.toHaveTextContent('Sede di prova');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL GIALLO CHE NON HA NESSUN'ALTRA STRADA — l'unico caso che nasce aperto.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * «Alunno riconosciuto, nessuna voce aperta»: il bambino è noto e le voci non ci
 * sono. Non c'è nessun suggerimento da confermare, e la ricerca fra le voci
 * aperte non può restituire niente — comporre è l'unica strada, e un pannello
 * chiuso la nasconde dietro un pulsante. Ovunque altrove resta chiuso, perché si
 * carica da sé e montarlo sempre pagherebbe quella lettura su ogni riga.
 *
 * ⚠️ QUESTO È IL CONTRATTO SCRITTO IN ANTICIPO. Il campo con cui il verdetto
 * arriva sulla riga del registro non viaggia ANCORA fin qui: lo sta aggiungendo
 * al matcher un lavoro parallelo a questo. Il ramo nel componente è dietro un
 * controllo difensivo, quindi finché il campo manca il popup si comporta
 * esattamente come prima.
 *
 * 🔴 MA IL NOME NON È PIÙ INDOVINATO, e fino al 2026-09-20 lo era: qui si
 * asserivano DUE forme plausibili e nessuna delle due vere, cioè il lotto sarebbe
 * restato verde il giorno dell'atterraggio mentre la funzione non partiva — il
 * «segnale falso» di `silenzio_assente_vs_segnale_falso.md`. La forma qui sotto è
 * quella che il produttore scrive, letta in `src/lib/pagamenti/riconciliazione.ts`:
 * `motivo_stato` (una stringa sola, di tipo `MotivoStato`) e `alunni_senza_voci`
 * (uuid, mai il CF). Anche il valore è tipato: `alunno_senza_voci_aperte` è un
 * `MotivoRinuncia & MotivoStato` nel componente, quindi un rinominio da una delle
 * due parti diventa rosso in `tsc` prima che in una prova.
 *
 * ⚠️ E LA FORMA È UNA SOLA. Per un giro se ne asserivano tre — «annidata» e
 * «piatta» accanto a quella vera — su campi che nessuno scrive: due prove su tre
 * giravano su dati inventati qui dentro, cioè alzavano il conteggio senza coprire
 * niente e avrebbero tenuto in vita quattro letture morte nel componente. Un caso
 * di prova vale se esiste un produttore che scrive quella forma.
 */
describe('MovimentoDialog — la composizione nasce aperta solo sul giallo senza voci', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaFattura.props.length = 0; spiaComponi.props.length = 0; });

  const ALUNNO = 'a1b2c3d4-0000-4000-8000-000000000009';
  /**
   * La riga come arriverà dal registro, nella forma che il matcher scrive:
   * `motivo_stato` e `alunni_senza_voci` di `RisultatoMatch`.
   */
  const conVerdetto = (): MovimentoUi => ({
    ...movBase,
    stato: 'suggerito',
    suggerimenti: [],
    motivo_stato: 'alunno_senza_voci_aperte',
    alunni_senza_voci: [ALUNNO],
  } as MovimentoUi);

  it('verdetto «alunno riconosciuto, nessuna voce aperta» → pannello già aperto e puntato', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={conVerdetto()} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(screen.getByTestId('pannello-componi')).toBeInTheDocument();
    expect(spiaComponi.props.at(-1)).toMatchObject({ alunniIniziali: [ALUNNO] });
  });

  it('CONTROPROVA · un altro motivo, o nessun bambino, e il pannello resta CHIUSO', () => {
    vi.stubGlobal('fetch', vi.fn());
    // Motivo diverso: non è questo il caso senza uscite.
    const { unmount } = render(
      <MovimentoDialog
        movimento={{ ...movBase, motivo_stato: 'importo_non_quadra', alunni_senza_voci: [ALUNNO] } as MovimentoUi}
        aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />,
    );
    expect(screen.queryByTestId('pannello-componi')).toBeNull();
    unmount();

    // Motivo giusto ma nessun bambino su cui puntare: aprirlo rimetterebbe in
    // piedi il difetto di partenza (contesto vuoto → «Conferma» spento).
    render(
      <MovimentoDialog
        movimento={{ ...movBase, suggerimenti: [], motivo_stato: 'alunno_senza_voci_aperte', alunni_senza_voci: [] } as MovimentoUi}
        aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />,
    );
    expect(screen.queryByTestId('pannello-componi')).toBeNull();
  });
});
