import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntlMessageFormat } from 'intl-messageformat';
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog';
import type { MovimentoUi, PagamentoApertoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';

/**
 * ─── IL POPUP DEL MOVIMENTO: LA COMPOSIZIONE, LA RIAPERTURA E IL 409 ─────────
 *
 * Questo file sta ACCANTO a `MovimentoDialog.test.tsx` e non dentro, ed è una
 * scelta: quello è il collaudo della schermata com'era (suggerimenti, ricerca,
 * documenti, forma) e resta la prova che i due percorsi vecchi non si sono mossi;
 * qui vivono i tre difetti misurati della fetta «conciliazione composita», e due
 * di essi hanno bisogno di mock di modulo (`ComposizioneBonifico`, e
 * `messaggioDaCorpo` per dimostrare che la risincronizzazione NON legge più la
 * frase) che sarebbe sbagliato imporre a 60 test che non li riguardano.
 *
 * I tre difetti, come sono stati misurati:
 *
 *  (a) IL CORPO DELLA RISPOSTA FINIVA NEL CESTINO. Su `r.ok && j.success` il
 *      popup faceva `onDone(); onClose();` e basta. Conseguenza: `movimenti_riaperti`
 *      non arrivava a nessuno, e soprattutto **l'avviso delle fatture vive non
 *      era mostrato a nessuno** — mentre la decisione del titolare era «riapri
 *      comunque, AVVISANDO». Misurato: 167 riaperture su 174 (96%) hanno una
 *      fattura viva, cioè oggi NESSUNA avviserebbe.
 *
 *  (b) LA RISINCRONIZZAZIONE DIPENDEVA DAL TESTO TRADOTTO. Sul 409 la lista si
 *      ricaricava solo se la frase mostrata corrispondeva a `/operatore|confermato/i`:
 *      un'euristica sulla PROSA, già cieca in inglese prima di questo lavoro, e
 *      cieca in tutt'e due le lingue sulla frase nuova
 *      `RIAPERTURA_STORNATA_NON_RIAPERTA` — che è proprio quella che dichiara uno
 *      storno già registrato.
 *
 *  (c) IL 200 CHE NON È UN SUCCESSO PIENO. `componi` risponde **200** con
 *      `CONCILIAZIONE_MOVIMENTO_NON_LEGATO` quando l'incasso è stato registrato
 *      ma la riga bancaria non si è legata. Non è un errore, ed è un 200 di
 *      proposito: un 500 direbbe «nulla è stato scritto», sarebbe falso, e
 *      inviterebbe a ritentare — cioè a incassare due volte.
 */

/**
 * IL TESTO CHE IL COMPONENTE RENDERÀ, RICAVATO COME LO RICAVA `test/setup.ts`.
 * Stessa tesi del file gemello: «il componente rende LA VOCE DI QUESTA CHIAVE»,
 * non «rende questa prosa italiana», che legherebbe il test al giorno in cui il
 * catalogo cambia parole.
 */
const CATALOGO_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>;
const SHARED_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/shared.json'), 'utf8'),
) as Record<string, string>;
const testo = (chiave: string): string => CATALOGO_IT[chiave] ?? `adminContabilita.${chiave}`;

/**
 * Il testo ICU come lo rende `test/setup.ts`: stesso motore, stessi valori.
 * Scriverlo a mano («Pagamento registrato: 2 voci e 1 ticket · € 150,00») legherebbe
 * questo file alla giornata in cui qualcuno riscrive quella frase, e il rosso
 * direbbe «il catalogo è cambiato» invece di «il componente è rotto».
 */
const testoIcu = (chiave: string, valori: Record<string, unknown>): string =>
  String(new IntlMessageFormat(testo(chiave), 'it').format(valori));

/** Il riepilogo della composizione, com'è scritto in catalogo. */
const riepilogo = (voci: number, ticket: number, totale: string) =>
  testoIcu('reconComposizioneRegistrata', { voci, ticket, totale });

/** FatturaButton fa fetch proprie: stub per isolare il dialog. */
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <button type="button">Emetti fattura</button>,
}));

/**
 * IL PANNELLO «COMPONI IL PAGAMENTO» — lo stub REGISTRA LE PROPS.
 *
 * Il contratto è fissato dall'orchestratore e il pannello si carica e si registra
 * da sé: questo popup lo MONTA e basta. Uno stub che rendesse solo un segnaposto
 * sarebbe verde anche con `movimentoId` non passato — che è esattamente la specie
 * di difetto che questo file deve intercettare.
 */
const spiaComponi = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/features/admin/pagamenti/ComposizioneBonifico', () => ({
  ComposizioneBonifico: (props: Record<string, unknown>) => {
    spiaComponi.props.push(props);
    const fatto = props.onFatto as (r: {
      voci: number; ticket: number; totale: number; movimentoConfermato: boolean;
    }) => void;
    return (
      <div data-testid="pannello-componi">
        <button type="button" onClick={() => fatto({ voci: 2, ticket: 1, totale: 150, movimentoConfermato: true })}>
          finto-registra
        </button>
        <button type="button" onClick={() => fatto({ voci: 1, ticket: 0, totale: 150, movimentoConfermato: false })}>
          finto-registra-non-legato
        </button>
        <button type="button" onClick={() => (props.onChiudi as () => void)()}>finto-chiudi</button>
      </div>
    );
  },
}));

/**
 * `messaggioDaCorpo` VERO di default, FORZABILE quando serve.
 *
 * ⚠️ È la sola prova possibile che la risincronizzazione non legga più la frase:
 * con il testo mostrato forzato a una stringa qualunque — cioè una «traduzione»
 * che non contiene nessuna delle parole dell’euristica vecchia, in nessuna lingua
 * — il refetch deve partire lo stesso. Un test che si limitasse a cambiare la
 * frase del corpo sarebbe più debole: `messaggioDaCorpo` sostituisce la prosa con
 * quella di catalogo appena riconosce il `codice`, e il verde potrebbe venire da lì.
 */
const spiaMsg = vi.hoisted(() => ({ forzato: null as string | null }));
vi.mock('@/lib/ui/esito-fetch', async (importOriginal) => {
  const reale = await importOriginal<typeof import('@/lib/ui/esito-fetch')>();
  return {
    ...reale,
    messaggioDaCorpo: (corpo: unknown, fallback: string) =>
      spiaMsg.forzato ?? reale.messaggioDaCorpo(corpo, fallback),
  };
});

const aperti: PagamentoApertoUi[] = [
  { id: 'pa1', descrizione: 'Iscrizione', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Tina', cognome: 'Blu' } },
  { id: 'pa2', descrizione: 'Mensa Novembre', importo: 60, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Ugo', cognome: 'Verdi' } },
];

const daAbbinare: MovimentoUi = {
  id: 'm1',
  data_operazione: '2026-10-05',
  importo: 150,
  causale: 'Bonifico retta',
  controparte: 'Mario Rossi',
  stato: 'suggerito',
  suggerimenti: [
    { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Aldo Neri · Retta Ottobre' },
  ],
  pagamento_id: null,
};

const confermato: MovimentoUi = { ...daAbbinare, stato: 'confermato', pagamento_id: 'pg1', suggerimenti: [] };

const ref = () => createRef<HTMLButtonElement>();

/** La lettura del pagamento collegato che il popup fa sui movimenti confermati. */
const rispostaPagamento = (patch: () => Promise<unknown>) =>
  vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return patch();
    return { ok: true, status: 200, json: async () => ({ success: true, data: { stato: 'pagato', fattura_stato: 'emessa' } }) };
  });

const riapri = async () => {
  fireEvent.click(await screen.findByRole('button', { name: testo('movdlgRiapri') }));
};

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — il pannello «Componi il pagamento»', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaComponi.props.length = 0; spiaMsg.forzato = null; });

  it('il pannello NON è montato finché non si preme «Componi il pagamento»', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(screen.queryByTestId('pannello-componi')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: testo('reconComponiTitolo') })).toBeInTheDocument();
  });

  it('premuto il pulsante, il pannello riceve movimento, importo e data — non un segnaposto', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    expect(screen.getByTestId('pannello-componi')).toBeInTheDocument();
    expect(spiaComponi.props.at(-1)).toMatchObject({
      movimentoId: 'm1',
      importoMovimento: 150,
      dataOperazione: '2026-10-05',
    });
  });

  it('il pannello vive SOTTO i suggerimenti, dove la decisione lo mette', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    const testi = [...container.querySelectorAll<HTMLElement>('h3, [data-testid="pannello-componi"]')];
    const iSugg = testi.findIndex((e) => e.textContent === testo('movdlgSuggerimenti'));
    const iPann = testi.findIndex((e) => e.dataset.testid === 'pannello-componi');
    expect(iSugg, 'i suggerimenti non ci sono più').toBeGreaterThanOrEqual(0);
    expect(iPann, 'il pannello non è montato').toBeGreaterThan(iSugg);
  });

  it('`onChiudi` lo smonta e restituisce il pulsante, senza toccare i due percorsi vecchi', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    fireEvent.click(screen.getByRole('button', { name: 'finto-chiudi' }));

    expect(screen.queryByTestId('pannello-componi')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: testo('reconComponiTitolo') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })).toBeInTheDocument();
    expect(screen.getByLabelText(testo('movdlgCercaAriaLabel'))).toBeInTheDocument();
  });

  /**
   * ─── CHIUSO IL PANNELLO, IL FUOCO NON CADE SUL `<body>` (WCAG 2.4.3) ────────
   *
   * MISURATO: premuto «Chiudi» dentro il pannello, il pulsante che aveva il fuoco
   * viene smontato e `document.activeElement` finisce su `<body>`. Il focus-trap
   * del `Modal` lo recupera al primo Tab — quindi non si esce dal dialog — ma chi
   * naviga da tastiera riparte dall'inizio della finestra, e l'unico posto dove
   * tornare è proprio il pulsante da cui si era entrati.
   *
   * ⚠️ IL RIENTRO VALE SOLO PER LA VIA D'USCITA «SONO TORNATO INDIETRO». Quando la
   * composizione è andata a buon fine il popup si chiude, e lì il fuoco è del
   * `returnFocusRef` del `Modal` (la riga della lista): rubarglielo per darlo a un
   * pulsante che sta smontando sarebbe una seconda regressione al posto della prima.
   */
  it('chiuso il pannello, il fuoco torna su «Componi il pagamento» e non cade sul body', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    const apri = screen.getByRole('button', { name: testo('reconComponiTitolo') });
    apri.focus();
    // Àncora POSITIVA: si parte da un fuoco che C'È, altrimenti «è tornato» non
    // distinguerebbe un rientro riuscito da un fuoco mai mosso.
    expect(document.activeElement).toBe(apri);
    fireEvent.click(apri);

    fireEvent.click(screen.getByRole('button', { name: 'finto-chiudi' }));

    await waitFor(() => expect(screen.getByRole('button', { name: testo('reconComponiTitolo') })).toBeInTheDocument());
    expect(document.activeElement, 'il fuoco è caduto sul body: da tastiera si riparte dall’inizio')
      .toBe(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
  });

  it('andata bene: il fuoco NON viene rubato al `returnFocusRef` del Modal', async () => {
    // Il contro-caso del test qui sopra: chiusa la composizione con successo il
    // popup sparisce, e il rientro sul pulsante «Componi» sarebbe un fuoco dato a
    // un nodo che sta smontando. Deve restare fuori da quel pulsante.
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    fireEvent.click(screen.getByRole('button', { name: 'finto-registra' }));

    await waitFor(() => expect(screen.queryByTestId('pannello-componi')).not.toBeInTheDocument());
    const componi = screen.queryByRole('button', { name: testo('reconComponiTitolo') });
    expect(componi, 'il pulsante è tornato a schermo, quindi il caso è quello giusto').toBeInTheDocument();
    expect(document.activeElement).not.toBe(componi);
  });

  it('andata bene: il popup si CHIUDE e il riepilogo lo riceve l’ELENCO, non il popup', async () => {
    // Decisione di coordinamento: nel caso riuscito parla la fascia dell'elenco,
    // che è un vestito che l'operatrice conosce già (è quella dell'import). Se lo
    // dicessero tutt'e due, la stessa frase comparirebbe due volte a due
    // centimetri di distanza.
    vi.stubGlobal('fetch', vi.fn());
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    fireEvent.click(screen.getByRole('button', { name: 'finto-registra' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // I QUATTRO CAMPI, uno per uno: `toHaveBeenCalled()` sarebbe verde anche con
    // l'argomento non passato, che è esattamente il difetto da intercettare.
    expect(onDone).toHaveBeenCalledWith({ voci: 2, ticket: 1, totale: 150, movimentoLegato: true });
  });

  it('andata bene: il riepilogo NON resta anche nel popup (una frase, un posto solo)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    fireEvent.click(screen.getByRole('button', { name: 'finto-registra' }));

    // Àncora POSITIVA prima di misurare l'assenza: si aspetta che il pannello sia
    // sparito — un `waitFor` su un'assenza passerebbe mentre la schermata è ancora
    // quella di prima.
    await waitFor(() => expect(screen.queryByTestId('pannello-componi')).not.toBeInTheDocument());
    expect(screen.queryByText(riepilogo(2, 1, '€ 150,00'))).not.toBeInTheDocument();
  });

  it('riga NON legata: il popup RESTA APERTO e il PANNELLO resta montato — a parlare è lui', async () => {
    // Decisione di coordinamento: nel caso fallito la frase la dice il pannello
    // (`shared.erroreConciliazioneMovimentoNonLegato`, dal codice della rotta), e
    // il popup non ne scrive una seconda. Qui il pannello è uno stub, quindi ciò
    // che si misura è il CONFINE: che questo popup non lo smonti e non si chiuda.
    vi.stubGlobal('fetch', vi.fn());
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));

    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));

    await waitFor(() => expect(screen.getByTestId('pannello-componi')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('riga NON legata: l’elenco NON riceve l’esito, o la frase si leggerebbe DUE volte', async () => {
    // È l'unico punto in cui questa fetta e quella dell'elenco possono
    // contraddirsi a schermo: il ramo d'avviso della fascia si accende su
    // `movimentoLegato === false`, e qui non deve accendersi affatto.
    vi.stubGlobal('fetch', vi.fn());
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith();
    expect(onDone).not.toHaveBeenCalledWith(expect.objectContaining({ movimentoLegato: false }));
  });

  it('riga NON legata: i percorsi a voce singola spariscono SUBITO, non solo alla chiusura', async () => {
    // ⚠️ IL DIFETTO VERO STA PRIMA DEL «Chiudi». Il pannello resta montato e mostra
    // l'avviso; se accanto restassero «Conferma questo» e la ricerca manuale, la
    // stessa schermata che dice «non ripetere l'operazione» offrirebbe il pulsante
    // per rifarla — e sul bonifico il denaro è già scritto.
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    // Àncora POSITIVA: prima di comporre i due percorsi CI SONO — senza questa
    // riga il test sarebbe verde anche su una schermata che non li ha mai avuti.
    expect(screen.getAllByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })).not.toBeInTheDocument());
    expect(screen.queryByLabelText(testo('movdlgCercaAriaLabel'))).not.toBeInTheDocument();
    // …e il pannello, che è quello che parla, è ancora lì.
    expect(screen.getByTestId('pannello-componi')).toBeInTheDocument();
  });

  it('riga NON legata: sparisce anche «Ignora» — una riga da legare non si nasconde', async () => {
    // ⚠️ «Ignora» porta il movimento a `ignorato`, cioè FUORI dalla coda. Su una
    // riga il cui incasso è scritto ma che non si è legata, nasconderla è il modo
    // di non legarla mai più: resterebbe un incasso senza la riga bancaria che lo
    // giustifica, e nessuno a cercarla. Il piede tiene solo «Chiudi».
    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    // Àncora POSITIVA: prima di comporre «Ignora» C'È.
    expect(screen.getByRole('button', { name: new RegExp(testo('movdlgIgnora')) })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: new RegExp(testo('movdlgIgnora')) })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: testo('movdlgChiudi') })).toBeInTheDocument();
  });

  it('riga NON legata: «Chiudi» del pannello CHIUDE il popup, non riapre i percorsi vecchi', async () => {
    // ⚠️ È IL BUCO CHE RESTEREBBE. La via d'uscita del pannello è `onChiudi`, che
    // prima del 2026-09-13 riportava semplicemente all'abbinamento: dopo una
    // composizione registrata, quel ritorno significa «Conferma questo» e la
    // ricerca manuale SU UN BONIFICO IL CUI INCASSO È GIÀ A REGISTRO — cioè il
    // secondo incasso, offerto dalla stessa schermata che ha appena avvisato di non
    // farlo. Registrato il denaro, questo popup non ha più niente da offrire su
    // questa riga: si esce.
    vi.stubGlobal('fetch', vi.fn());
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));
    await waitFor(() => expect(screen.getByTestId('pannello-componi')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'finto-chiudi' }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(testo('movdlgCercaAriaLabel'))).not.toBeInTheDocument();
  });

  it('riga NON legata: UNA frase sola per il fatto — la seconda non esiste più in catalogo', async () => {
    // La frase è quella che la rotta DICHIARA col proprio codice
    // (`CONCILIAZIONE_MOVIMENTO_NON_LEGATO` → `erroreConciliazioneMovimentoNonLegato`)
    // e la mostra il pannello. Il popup non ne scrive nessuna: il titolo che lo
    // faceva — `reconComponiEsitoNonLegato` — è stato TOLTO dal catalogo, e questa
    // riga cade se torna.
    expect(CATALOGO_IT.reconComponiEsitoNonLegato).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn());
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    fireEvent.click(screen.getByRole('button', { name: testo('reconComponiTitolo') }));
    fireEvent.click(screen.getByRole('button', { name: 'finto-registra-non-legato' }));

    await waitFor(() => expect(screen.getByTestId('pannello-componi')).toBeInTheDocument());
    // Il popup non aggiunge nessuna regione viva propria: quella è del pannello.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sul movimento CONFERMATO il pannello non si apre nemmeno: non c’è niente da comporre', async () => {
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByText(testo('movdlgDocumenti'));
    expect(screen.queryByRole('button', { name: testo('reconComponiTitolo') })).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — la riapertura racconta CHE COSA ha fatto', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaComponi.props.length = 0; spiaMsg.forzato = null; });

  const esitoRiapertura = (corpo: unknown) =>
    rispostaPagamento(async () => ({ ok: true, status: 200, json: async () => corpo }));

  it('con fatture vive: la frase c’è E ci sono i NUMERI dei documenti', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
      avviso: {
        codice: 'RIAPERTURA_CON_FATTURA_VIVA',
        messaggio: 'Restano fatture vive: FPR 12/2026, FPR 13/2026.',
        numeri: ['FPR 12/2026', 'FPR 13/2026'],
      },
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();

    // La frase viene dal CODICE, tradotta come tutte le altre.
    expect(await screen.findByText(SHARED_IT.erroreRiaperturaConFatturaViva)).toBeInTheDocument();
    // E i numeri stanno in un campo loro: si elencano, non si estraggono dalla prosa.
    expect(screen.getByText('FPR 12/2026')).toBeInTheDocument();
    expect(screen.getByText('FPR 13/2026')).toBeInTheDocument();
    expect(screen.getByText(testo('reconComponiEsitoFattureVive'))).toBeInTheDocument();
  });

  it('senza fatture vive: nessun avviso — un avviso che compare sempre non è un avviso', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();

    // Àncora POSITIVA: si aspetta l'esito, POI si misura l'assenza dell'avviso.
    await screen.findByText(testo('reconComponiEsitoRiaperto'));
    expect(screen.queryByText(testo('reconComponiEsitoFattureVive'))).not.toBeInTheDocument();
    expect(screen.queryByText(SHARED_IT.erroreRiaperturaConFatturaViva)).not.toBeInTheDocument();
  });

  it('«movimenti_riaperti» arriva all’operatrice, al plurale giusto', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 3, incassi_stornati: 2 },
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();

    expect(await screen.findByText('3 righe dell’estratto conto sono tornate in coda')).toBeInTheDocument();
    expect(screen.getByText('2 incassi sono stati stornati')).toBeInTheDocument();
  });

  it('una riga sola: il singolare è diverso dal plurale', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();

    expect(await screen.findByText('Una riga dell’estratto conto è tornata in coda')).toBeInTheDocument();
    expect(screen.getByText('Un incasso è stato stornato')).toBeInTheDocument();
  });

  it('la riapertura ricarica comunque la lista, e NON chiude il popup sull’avviso', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
      avviso: { codice: 'RIAPERTURA_CON_FATTURA_VIVA', messaggio: 'x', numeri: ['FPR 12/2026'] },
    }));
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('l’avviso «non verificate» si mostra anche SENZA numeri, e non elenca il vuoto', async () => {
    vi.stubGlobal('fetch', esitoRiapertura({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: false, movimenti_riaperti: 1, incassi_stornati: 0 },
      avviso: { codice: 'RIAPERTURA_FATTURE_NON_VERIFICATE', messaggio: 'non verificate', numeri: [] },
    }));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();

    expect(await screen.findByText(SHARED_IT.erroreRiaperturaFattureNonVerificate)).toBeInTheDocument();
    expect(screen.queryByText(testo('reconComponiEsitoFattureVive'))).not.toBeInTheDocument();
  });

  it('riapertura NUDA (un movimento ignorato): niente da raccontare, si chiude come sempre', async () => {
    const ignorato: MovimentoUi = { ...daAbbinare, stato: 'ignorato', pagamento_id: null, suggerimenti: [] };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={ignorato} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — il 409 si risincronizza sul CODICE, mai sulla frase', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaComponi.props.length = 0; spiaMsg.forzato = null; });

  const patch409 = (corpo: unknown) =>
    rispostaPagamento(async () => ({ ok: false, status: 409, json: async () => corpo }));

  it('CONTROPROVA: la frase di `RIAPERTURA_STORNATA_NON_RIAPERTA` non contiene le parole dell’euristica vecchia', () => {
    // Se un giorno qualcuno riscrivesse quella frase mettendoci dentro «operatore»
    // o «confermato», i due test qui sotto tornerebbero verdi anche con l'euristica
    // rimessa al suo posto. Questa riga lo dichiara, e cade se succede.
    const EURISTICA_VECCHIA = /operatore|confermato/i;
    expect(EURISTICA_VECCHIA.test(SHARED_IT.erroreRiaperturaStornataNonRiaperta)).toBe(false);
  });

  it('409 `RIAPERTURA_STORNATA_NON_RIAPERTA`: la lista si ricarica (lo storno C’È già)', async () => {
    vi.stubGlobal('fetch', patch409({
      error: 'Il movimento è cambiato mentre lo si riapriva: lo storno è stato registrato.',
      codice: 'RIAPERTURA_STORNATA_NON_RIAPERTA',
      data: { incassi_stornati: 1, transazione_annullata: true },
    }));
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    // La frase è quella di CATALOGO del codice — l'unica che nomini lo storno già
    // registrato — e non contiene nessuna delle due parole dell'euristica vecchia.
    expect(await screen.findByRole('alert'))
      .toHaveTextContent(SHARED_IT.erroreRiaperturaStornataNonRiaperta);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('con una traduzione QUALUNQUE (frase forzata a «ZZZ») la risincronizzazione parte lo stesso', async () => {
    // È la prova decisiva: la decisione non passa più per il testo mostrato, che
    // qui non contiene nessuna delle parole di nessuna delle due lingue.
    spiaMsg.forzato = 'ZZZ';
    vi.stubGlobal('fetch', patch409({ error: 'qualunque cosa', codice: 'RIAPERTURA_STORNATA_NON_RIAPERTA' }));
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    expect(await screen.findByRole('alert')).toHaveTextContent('ZZZ');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('409 in INGLESE e senza codice: si risincronizza (l’euristica era cieca fuori dall’italiano)', async () => {
    spiaMsg.forzato = 'Someone else has just reconciled this bank transfer';
    vi.stubGlobal('fetch', patch409({ error: 'Someone else has just reconciled this bank transfer' }));
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })[0]);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  /**
   * ⚠️ QUESTO TEST È LA PROVA DI `vaRisincronizzato`, E PRIMA DEL 2026-09-13 NON
   * LO ERA. La chiamata stava DENTRO `if (r.status === 409)`, cioè dove la
   * risposta poteva essere solo un 409: su un 500 la funzione non veniva invocata
   * affatto, e il verde veniva dal ramo esterno. MISURATO mutando il sorgente:
   * con `stato >= 400` al posto di `stato === 409` restavano **82/82 verdi**, e
   * togliendo del tutto la condizione pure. Una prova che non distingue le due
   * versioni del codice non prova niente.
   *
   * Ora la decisione è presa su OGNI risposta non-ok, quindi allargare la soglia
   * fa risincronizzare il 500 e questa riga diventa rossa. Rifatta la misura dopo
   * la correzione: `stato >= 400` → rosso qui, e solo qui.
   */
  it('un 500 NON risincronizza: non è un conflitto di stato, è un guasto', async () => {
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Errore interno' }) })));
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    // Àncora POSITIVA: l'errore è a schermo, quindi la PATCH è stata processata —
    // senza, l'assenza qui sotto passerebbe misurando un istante troppo presto.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('un 503 nemmeno: la soglia è il CONFLITTO, non «tutto ciò che non è andato»', async () => {
    // Il 500 da solo lascerebbe passare una soglia scritta `stato === 500`. Due
    // punti sullo stesso lato la inchiodano: ciò che risincronizza è il 409, e
    // tutto il resto dei guasti no.
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({ ok: false, status: 503, json: async () => ({ error: 'Servizio non disponibile' }) })));
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    await riapri();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  /**
   * IL RIPIEGO DEL CONFLITTO NON È QUELLO DEL GUASTO, e adesso che i due rami sono
   * uno solo è una riga di codice che va difesa: «Operazione non possibile in
   * questo momento» dice che lo stato del server non permette la cosa — su un
   * guasto sarebbe falso, e «Errore nell'operazione» su un conflitto direbbe
   * «qualcosa si è rotto» a chi invece deve solo ricaricare.
   * Si vede solo col corpo MUTO: appena c'è `error` o un `codice` riconosciuto,
   * `messaggioDaCorpo` non arriva mai al ripiego.
   */
  it('col corpo MUTO, il 409 e il 500 non danno la stessa frase', async () => {
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({ ok: false, status: 409, json: async () => ({}) })));
    const { unmount } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await riapri();
    expect(await screen.findByRole('alert')).toHaveTextContent(testo('movdlgOperazioneNonPossibile'));
    unmount();

    vi.stubGlobal('fetch', rispostaPagamento(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await riapri();
    expect(await screen.findByRole('alert')).toHaveTextContent(testo('movdlgErroreOperazione'));
    // …e le due frasi sono davvero diverse: se il catalogo le facesse coincidere,
    // questo blocco starebbe difendendo una distinzione che non esiste più.
    expect(testo('movdlgOperazioneNonPossibile')).not.toBe(testo('movdlgErroreOperazione'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — i due percorsi vecchi non si sono mossi', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaComponi.props.length = 0; spiaMsg.forzato = null; });

  it('«Conferma questo» manda ancora la PATCH col pagamento_id del suggerimento, e chiude', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })[0]);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'p1' }) }),
    );
    expect(onDone).toHaveBeenCalled();
    // E non passa dal pannello: il caso a voce singola resta la strada di prima.
    expect(spiaComponi.props).toHaveLength(0);
  });

  it('conferma, ignora e riapri chiamano `onDone` SENZA argomento: nessuna fascia si accende', async () => {
    // L'argomento è facoltativo DI PROPOSITO: «assente» non deve accendere nessun
    // riepilogo nell'elenco. Una sola delle azioni di questo popup produce un
    // riepilogo da leggere, ed è la composizione.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const { unmount } = render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(testo('movdlgConfermaQuesto')) })[0]);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: new RegExp(testo('movdlgIgnora')) }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    unmount();

    const ignorato: MovimentoUi = { ...daAbbinare, stato: 'ignorato', pagamento_id: null, suggerimenti: [] };
    render(<MovimentoDialog movimento={ignorato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);
    await riapri();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(3));

    for (const chiamata of onDone.mock.calls) expect(chiamata).toEqual([]);
  });

  it('la ricerca manuale filtra e «Abbina» manda la PATCH sull’id scelto, e chiude', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.change(screen.getByLabelText(testo('movdlgCercaAriaLabel')), { target: { value: 'Mensa' } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(testo('movdlgAbbina')) }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'conferma', pagamento_id: 'pa2' }) }),
    );
  });

  it('«Ignora» resta quello di prima: PATCH e chiusura, senza riepiloghi', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={daAbbinare} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(testo('movdlgIgnora')) }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/riconciliazione/m1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ azione: 'ignora' }) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — forma dei riquadri nuovi', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); spiaComponi.props.length = 0; spiaMsg.forzato = null; });

  const token = (el: Element) => el.className.split(/\s+/);

  /** La riapertura che porta l'avviso: è l'unico stato in cui i riquadri nuovi esistono. */
  const conAvviso = () => rispostaPagamento(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
      avviso: { codice: 'RIAPERTURA_CON_FATTURA_VIVA', messaggio: 'x', numeri: ['FPR 12/2026', 'FPR 13/2026'] },
    }),
  }));

  it('nessun `text-kidville-muted` (2,51:1) e nessun fondo con l’alfa nel nome della classe', async () => {
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 1, incassi_stornati: 1 },
        avviso: { codice: 'RIAPERTURA_CON_FATTURA_VIVA', messaggio: 'x', numeri: ['FPR 12/2026'] },
      }),
    })));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await riapri();
    await screen.findByText(testo('reconComponiEsitoRiaperto'));

    expect(container.innerHTML).not.toContain('text-kidville-muted');
    expect(container.innerHTML).not.toContain('bg-kidville-cream/');
    expect(container.innerHTML).not.toContain('bg-kidville-warn-soft/');
  });

  it('nessuna chiave di catalogo grezza a schermo nei riquadri nuovi', async () => {
    vi.stubGlobal('fetch', rispostaPagamento(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { stato: 'da_abbinare', transazione_annullata: true, movimenti_riaperti: 2, incassi_stornati: 1 },
        avviso: { codice: 'RIAPERTURA_CON_FATTURA_VIVA', messaggio: 'x', numeri: ['FPR 12/2026'] },
      }),
    })));
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await riapri();
    await screen.findByText(testo('reconComponiEsitoRiaperto'));

    const CHIAVE_GREZZA = /^adminContabilita\.[a-zA-Z]/;
    const scappate = [...container.querySelectorAll<HTMLElement>('*')]
      .flatMap((e) => [...e.childNodes])
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .filter((s) => CHIAVE_GREZZA.test(s));
    expect(scappate).toEqual([]);
  });

  /**
   * ─── L'AVVISO DELL'ESITO IN ALTO CONTRASTO — E IL NUMERO CHE ERA SBAGLIATO ──
   *
   * Questo riquadro nasceva SENZA l'àncora `kv-recon-avviso-sede`, e la ragione
   * scritta nel codice era: «in Alto Contrasto il fondo crema diventa il grigio
   * scurissimo e `warn-strong` ci vale 5,62:1, sopra i 4,5:1 di WCAG 1.4.3».
   *
   * ⚠️ QUEL 5,62 NON ERA DI QUESTA COPPIA. Ricalcolato con la stessa formula del
   * lock `riconciliazione-a11y-css.test.ts`, `warn-strong` sulla superficie scura
   * del popup vale **3,10:1** — sotto soglia, e l'etichetta dei numeri è a 11px
   * extra-grassetto, cioè testo NORMALE per WCAG (il «testo grande» parte da 18pt,
   * o 14pt in grassetto). Il 5,62 è il rapporto di `error-strong` sul BIANCO, ed
   * era già scritto sbagliato in `globals.css`: una decisione appoggiata su un
   * numero mai misurato.
   *
   * La regola HC esiste già ed è quella dell'avviso «altra sede»: porta filetto e
   * inchiostro all'ambra, **10,12:1**. Basta portare la classe — `globals.css` non
   * si tocca, che era la ragione dichiarata per non farlo.
   */
  it('l’avviso dell’esito porta l’àncora HC: senza, il suo inchiostro vale 3,10:1', async () => {
    vi.stubGlobal('fetch', conAvviso());
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await riapri();

    const frase = await screen.findByText(SHARED_IT.erroreRiaperturaConFatturaViva);
    const riquadro = frase.closest('.border-l-4') as HTMLElement;
    expect(riquadro, 'il riquadro d’avviso non è più riconoscibile dal suo filetto').not.toBeNull();
    // L'àncora della regola di `globals.css` — senza, filetto e glifo restano
    // `warn-strong` sul nero e nessuna riga di foglio li raggiunge.
    expect(token(riquadro), 'manca l’àncora dell’Alto Contrasto').toContain('kv-recon-avviso-sede');
    // …e in luce normale il vestito non cambia: filetto laterale e inchiostro d'avviso.
    expect(token(riquadro)).toContain('border-kidville-warn-strong');
    expect(token(riquadro).some((c) => /^border-l(-|$)/.test(c)), 'il filetto è LATERALE').toBe(true);
  });

  it('CONTROLLO NUMERICO: è la coppia di oggi a essere sotto soglia (3,10:1 contro 10,12:1)', () => {
    // Stessa formula del lock `riconciliazione-a11y-css.test.ts`. Senza questa
    // riga, il test qui sopra difenderebbe una classe senza sapere perché.
    const luminanza = (h: string) => {
      const c = [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255)
        .map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const cr = (a: string, b: string) => {
      const [x, y] = [luminanza(a), luminanza(b)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    // I tre colori si RILEGGONO dal foglio: cablarli farebbe sopravvivere questa
    // prova a un cambio di token, difendendo un numero che non esiste più.
    expect(css).toContain('--color-kidville-warn-strong: #A64F09');
    expect(css, 'la superficie scura del popup').toContain('background-color: #1A1A1A');
    expect(css, 'l’ambra della regola d’avviso').toContain('border-color: #FFB84D');

    expect(cr('#A64F09', '#1A1A1A'), 'senza l’àncora: sotto i 4,5:1 di WCAG 1.4.3').toBe(3.1);
    expect(cr('#FFB84D', '#1A1A1A'), 'con l’àncora').toBe(10.12);
    // E il 5,62 su cui la decisione era stata appoggiata: è di un'ALTRA coppia.
    expect(cr('#C62828', '#FFFFFF')).toBe(5.62);
  });

  /**
   * ─── I CHIP DEI NUMERI: DUE NERI VICINI SI SEPARANO COL FILETTO ─────────────
   *
   * `bg-kidville-white` dentro il popup diventa #1A1A1A in Alto Contrasto, e la
   * sezione che li ospita è già #1A1A1A: **1,00:1**, la pillola sparisce. Il testo
   * si legge (l'inchiostro passa a bianco), ma l'elenco smette di essere un elenco
   * di documenti e diventa una fila di parole.
   *
   * Il criterio è già scritto in `globals.css` accanto alle fasce piene di stato —
   * «in Alto Contrasto due neri vicini si separano col filetto e non più col
   * colore» — e `border-kidville-line` è il solo filetto che la regola HC del
   * popup ridipinge (a bianco, 17,4:1 sulla superficie scura). Nessuna riga nuova
   * in `globals.css`.
   */
  it('i chip dei numeri hanno un filetto, o in Alto Contrasto spariscono dentro il fondo', async () => {
    vi.stubGlobal('fetch', conAvviso());
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);
    await riapri();

    const chip = await screen.findByText('FPR 12/2026');
    const classi = token(chip);
    // Àncora POSITIVA: è davvero la pillola bianca, non un altro nodo di testo.
    expect(classi, 'il chip non è più una pillola su carta bianca').toContain('bg-kidville-white');
    expect(classi, 'manca il filetto che l’Alto Contrasto ridipinge').toContain('border-kidville-line');
    expect(classi.some((c) => c === 'border' || /^border-\d/.test(c)), 'il filetto ha una larghezza').toBe(true);
    // E il secondo chip ha lo stesso vestito: non si veste solo il primo.
    expect(token(screen.getByText('FPR 13/2026'))).toContain('border-kidville-line');
  });
});
