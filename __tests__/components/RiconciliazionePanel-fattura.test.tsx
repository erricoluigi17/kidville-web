import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';

/**
 * IL CHIP DELLA FATTURA SULLA RIGA DEL MOVIMENTO.
 *
 * Tre stati che si somigliano solo a parole: «Fattura FPR 1947/26» (il documento c'è, e si
 * dice quale), «Scartata, da riemettere» (c'è stato un tentativo, ed è fallito) e «Da
 * fatturare» (non è mai partito niente). Il quarto caso è il più insidioso: `fattura: null`,
 * cioè la lista non è riuscita a leggerlo — e allora NON si scrive niente, perché un chip
 * qualunque sarebbe una bugia detta con sicurezza.
 *
 * ─── AGGIORNATO IL 2026-09-05 CON LA FUSIONE (PR #118 + filtro di fatturazione) ──
 *
 * Due cose sono cambiate, e le asserzioni le seguono invece di essere ammorbidite:
 *
 *  1. IL CHIP NON È PIÙ UN `Badge`. È lo stesso componente della lista e del popup
 *     (`ChipFatturazione`), con la pelle MISURATA di `CHIP_FATTURAZIONE`: fondi PIENI
 *     (carta bianca o giallo), mai `-soft` semitrasparente, perché il chip vive sopra il
 *     fondo VERDE della riga confermata — dove un fondo soft scende sotto AA. Quindi qui
 *     si verificano le classi vere, più l'àncora `kv-recon-chip--*` dell'Alto Contrasto,
 *     che il `Badge` non aveva affatto: l'asserzione controlla di più, non di meno.
 *
 *  2. «DA FATTURARE» PRETENDE IL PAGAMENTO SALDATO. `fattura.stato === 'da_fatturare'`
 *     dice solo «nessuna riga in `fatture_emesse`», e da sola non basta a chiedere di
 *     agire: su un pagamento parziale la fattura non si emette e l'emissione la
 *     rifiuterebbe, quindi l'invito manderebbe l'operatore contro un rifiuto. Il chip
 *     nasce dai due campi che il GET manda insieme al documento (`pagamento_stato` +
 *     `fattura_stato`), ed è per questo che i fixture qui sotto li portano: è la risposta
 *     che il server produce davvero.
 */
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const movimenti = [
  { id: 'm1', data_operazione: '2026-10-05', importo: 150, causale: 'BONIFICO UNO', controparte: '', stato: 'confermato', pagamento_id: 'pg-1', suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1947/26'] } },
  { id: 'm2', data_operazione: '2026-10-06', importo: 160, causale: 'BONIFICO DUE', controparte: '', stato: 'confermato', pagamento_id: 'pg-2', suggerimenti: [], fattura: { stato: 'scartata', numeri: [] } },
  // Nessun documento in `fatture_emesse` E pagamento saldato: è lo scenario in cui
  // «Da fatturare» è un invito ad agire vero. I due campi accanto a `fattura` sono
  // quelli che il GET manda sulla stessa riga.
  { id: 'm3', data_operazione: '2026-10-07', importo: 170, causale: 'BONIFICO TRE', controparte: '', stato: 'confermato', pagamento_id: 'pg-3', suggerimenti: [], fattura: { stato: 'da_fatturare', numeri: [] }, pagamento_stato: 'pagato', fattura_stato: 'non_richiesta' },
  { id: 'm4', data_operazione: '2026-10-08', importo: 180, causale: 'BONIFICO QUATTRO', controparte: '', stato: 'confermato', pagamento_id: 'pg-4', suggerimenti: [], fattura: null },
  { id: 'm5', data_operazione: '2026-10-09', importo: 190, causale: 'BONIFICO CINQUE', controparte: '', stato: 'da_abbinare', pagamento_id: null, suggerimenti: [] },
];

const aperti = [
  { id: 'pa1', descrizione: 'Retta', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Nome', cognome: 'Fabbri' } },
];

function stubFetch(movs: unknown[] = movimenti) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: movs }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
  });
}

/** La riga (li) del movimento con quella causale. */
const rigaDi = (causale: string) => screen.getByText(new RegExp(causale)).closest('li') as HTMLLIElement;

describe('RiconciliazionePanel — lo stato della fattura sulla riga', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('fattura emessa → chip verde col numero completo di sezionale', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO UNO/)).toBeInTheDocument());

    const chip = screen.getByText('Fattura FPR 1947/26');
    // Fondo PIENO e inchiostro verde: 6,51:1 sopra il verde della riga confermata.
    expect(chip.className).toContain('bg-kidville-white');
    expect(chip.className).toContain('text-kidville-green');
    // …e l'àncora dell'Alto Contrasto, senza la quale in HC il chip resterebbe chiaro
    // su riga nera: `@theme inline` inlina gli hex, nessun rimappaggio di token lo tocca.
    expect(chip.className).toContain('kv-recon-chip--fatturata');
    // nessuna opacità Tailwind sul fondo: è ciò che faceva scendere il contrasto
    expect(chip.className).not.toMatch(/bg-kidville-[a-z-]+\//);
    // token via classi, mai hex letterali
    expect(chip.className).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('fattura scartata → chip rosso «Scartata, da riemettere» (non «Da fatturare»)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO DUE/)).toBeInTheDocument());

    const chip = screen.getByText('Scartata, da riemettere');
    expect(chip.className).toContain('text-kidville-error-strong');
    expect(chip.className).toContain('kv-recon-chip--scartata');
    expect(rigaDi('BONIFICO DUE').textContent).not.toContain('Da fatturare');
  });

  it('nessuna fattura, pagamento SALDATO → chip «Da fatturare» (giallo pieno: chiede di agire)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO TRE/)).toBeInTheDocument());

    const chip = screen.getByText('Da fatturare');
    expect(chip.className).toContain('bg-kidville-yellow');
    expect(chip.className).toContain('kv-recon-chip--da-fatturare');
    expect(rigaDi('BONIFICO TRE')).toContainElement(chip);
  });

  it('nessuna fattura ma pagamento NON saldato → nessun invito ad agire', async () => {
    // Regola più severa di «zero righe in fatture_emesse»: su un pagamento parziale
    // l'emissione rifiuta, quindi «Da fatturare» manderebbe l'operatore contro un muro.
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mp', data_operazione: '2026-10-12', importo: 90, causale: 'BONIFICO OTTO', controparte: '', stato: 'confermato', pagamento_id: 'pg-8', suggerimenti: [], fattura: { stato: 'da_fatturare', numeri: [] }, pagamento_stato: 'parziale', fattura_stato: 'non_richiesta' },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO OTTO/)).toBeInTheDocument());

    expect(rigaDi('BONIFICO OTTO').textContent).not.toContain('Da fatturare');
  });

  it('fattura non leggibile (null) → NESSUN chip: «non lo so» non si scrive come «no»', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO QUATTRO/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO QUATTRO').textContent ?? '';
    expect(riga).not.toContain('Da fatturare');
    expect(riga).not.toContain('Scartata');
    // «Fattur» TRONCO, non «Fattura»: da quando l'etichetta è un plurale ICU, un
    // chip con DUE documenti scrive «Fatture …», e `not.toContain('Fattura')` lo
    // lascerebbe passare — cioè la guardia più importante di questo test (non si
    // scrive niente quando non si sa) resterebbe verde proprio sul caso nuovo.
    // Il tronco copre singolare e plurale con una sola asserzione.
    expect(riga).not.toContain('Fattur');
  });

  it('riga non ancora abbinata → nessun chip (il campo non arriva nemmeno)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO CINQUE/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO CINQUE').textContent ?? '';
    expect(riga).toContain('Da abbinare'); // l'etichetta a semaforo resta
    expect(riga).not.toContain('Da fatturare');
    // Tronco «Fattur» per la stessa ragione della riga sopra: «Fatture …» al
    // plurale sfuggirebbe a un `not.toContain('Fattura')`.
    expect(riga).not.toContain('Fattur');
  });

  it('senza pagamento_id il chip non compare NEMMENO se il server mandasse una fattura', async () => {
    // DUE documenti, e non è un dettaglio del fixture: con UNO solo l'etichetta
    // sarebbe «Fattura FPR 1/26», che `/^Fattura /` e `/^Fattur[ae] /` pescano
    // identiche — cioè la classe di caratteri qui sotto sarebbe copertura in
    // avanti e non una guardia. Con due, l'etichetta diventa «Fatture …» e il
    // singolare NON la vedrebbe: se il filtro su `pagamento_id` si rompesse, solo
    // il matcher scritto così diventerebbe rosso. Numeri SINTETICI, mai
    // progressivi veri di produzione.
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mx', data_operazione: '2026-10-10', importo: 200, causale: 'BONIFICO SEI', controparte: '', stato: 'suggerito', pagamento_id: null, suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1/26', 'Asilo 2/2026'] } },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO SEI/)).toBeInTheDocument());

    // `[ae]`, e NON `/^Fatture? /`: quest'ultima è «Fattur» + una «e» facoltativa,
    // quindi è cieca a «Fattura ». La classe di caratteri le prende entrambe, ed è
    // ciò che rende questa guardia capace di vedere anche un chip a DUE documenti
    // («Fatture …»), che è la forma in cui il difetto tornerebbe oggi.
    expect(screen.queryByText(/^Fattur[ae] /)).toBeNull();
  });

  it('le due fonti insieme: vince il NUMERO del documento, non il generico «Fatturata»', async () => {
    // La riga porta ENTRAMBI i dati, come li manda il GET dopo la fusione: il riassunto
    // su `pagamenti` (`fattura_stato: 'emessa'`) e il documento vero con il suo numero.
    // «Fatturata» sarebbe vero e inutile; «Fattura FPR 1947/26» si va a cercare in archivio.
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mf', data_operazione: '2026-10-13', importo: 150, causale: 'BONIFICO NOVE', controparte: '', stato: 'confermato', pagamento_id: 'pg-10', suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1947/26'] }, pagamento_stato: 'pagato', fattura_stato: 'emessa' },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO NOVE/)).toBeInTheDocument());

    expect(screen.getByText('Fattura FPR 1947/26')).toBeInTheDocument();
    const riga = rigaDi('BONIFICO NOVE').textContent ?? '';
    // il sezionale, il numero e l'anno a DUE cifre, come li scrive `formattaNumeroFattura`
    expect(riga).toContain('Fattura FPR 1947/26');
    // e nessuna traccia dell'etichetta secca che il numero sostituisce
    expect(screen.queryByText('Fatturata')).toBeNull();
  });

  it('pagamento ripartito su due quote → i due numeri nello stesso chip, uniti da « · »', async () => {
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mq', data_operazione: '2026-10-11', importo: 300, causale: 'BONIFICO SETTE', controparte: '', stato: 'confermato', pagamento_id: 'pg-9', suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1947/26', 'Asilo 2328/2026'] } },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO SETTE/)).toBeInTheDocument());

    // Due documenti ⇒ «Fatture», al plurale (ICU, tester localizzazione 2026-09-05):
    // il chip non dice «Fattura» di un pagamento che ne ha due.
    expect(screen.getByText('Fatture FPR 1947/26 · Asilo 2328/2026')).toBeInTheDocument();
  });

  it('un solo chip per riga, e solo sulle righe abbinate con esito noto', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO UNO/)).toBeInTheDocument());

    // 5 righe caricate, 3 con esito noto (emessa/scartata/da_fatturare)
    expect(container.querySelectorAll('li')).toHaveLength(5);
    const chip = [
      // `[ae]` per contare anche i chip al plurale: qui il documento è uno solo
      // («Fattura FPR 1947/26»), ma con /^Fatture? / — che è cieca al singolare —
      // il conteggio scenderebbe da 3 a 2, e un chip in più o in meno passerebbe.
      ...screen.queryAllByText(/^Fattur[ae] /),
      ...screen.queryAllByText('Scartata, da riemettere'),
      ...screen.queryAllByText('Da fatturare'),
    ];
    expect(chip).toHaveLength(3);
  });

  it('la voce ATTIVA della coda fatture: un chip suo accanto a «Da fatturare» (2026-09-23)', async () => {
    // Consegna 2a della coda fatture, rilievo (e). Una propria `stubFetch`: un «Da
    // fatturare» in più in `movimenti` romperebbe il `getByText` del caso giallo.
    // UNDICI porta `'tolta'`, uno stato FUORI dai tre: il server non lo manda (`attivo()`
    // in `stato-righe.ts`), ed è la prova della guardia del pannello — senza, `pelle.testo`
    // lancerebbe un TypeError e la lista intera non si renderebbe.
    const saldata = { stato: 'confermato', controparte: '', suggerimenti: [], fattura: { stato: 'da_fatturare', numeri: [] }, pagamento_stato: 'pagato', fattura_stato: 'non_richiesta' };
    vi.stubGlobal('fetch', stubFetch([
      { ...saldata, id: 'mc9', data_operazione: '2026-10-14', importo: 150, causale: 'BONIFICO NOVE', pagamento_id: 'pg-c9', coda_stato: 'in_invio' },
      { ...saldata, id: 'mc10', data_operazione: '2026-10-15', importo: 151, causale: 'BONIFICO DIECI', pagamento_id: 'pg-c10', coda_stato: null },
      { ...saldata, id: 'mc11', data_operazione: '2026-10-16', importo: 152, causale: 'BONIFICO UNDICI', pagamento_id: 'pg-c11', coda_stato: 'tolta' },
      { ...saldata, id: 'mc12', data_operazione: '2026-10-17', importo: 153, causale: 'BONIFICO DODICI', pagamento_id: 'pg-c12', coda_stato: 'errore' },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO NOVE/)).toBeInTheDocument());

    const inInvio = within(rigaDi('BONIFICO NOVE')).getByTestId('coda-chip');
    expect(inInvio).toHaveTextContent('In invio');
    expect(inInvio.className).toContain('kv-recon-chip');
    expect(inInvio.className).toContain('bg-kidville-white');
    expect(inInvio.className).toContain('text-kidville-info-strong');
    // carta bianca in Alto Contrasto: nessuna àncora di variante
    expect(inInvio.className).not.toContain('kv-recon-chip--');
    expect(inInvio.className).not.toMatch(/bg-kidville-[a-z-]+\//);

    const errore = within(rigaDi('BONIFICO DODICI')).getByTestId('coda-chip');
    expect(errore).toHaveTextContent('Errore in coda');
    expect(errore.className).toContain('text-kidville-error-strong');
    expect(errore.className).toContain('kv-recon-chip--coda-errore');

    // Le assenze DOPO la presenza delle righe (.claude/rules/test.md, punto 3). La riga
    // UNDICI c'è: lo stato ignoto non ha fatto cadere la lista.
    expect(within(rigaDi('BONIFICO DIECI')).queryByTestId('coda-chip')).toBeNull();
    expect(within(rigaDi('BONIFICO UNDICI')).getByText('Da fatturare')).toBeInTheDocument();
    expect(within(rigaDi('BONIFICO UNDICI')).queryByTestId('coda-chip')).toBeNull();
  });
});

/**
 * ─── «PERCHÉ QUESTA RIGA LA VEDO E NON LA POSSO FATTURARE» ───────────────────
 *
 * Conseguenza dichiarata della decisione n. 15 del titolare — un bonifico che paga
 * figli di sedi diverse produce UN documento solo, intestato a una sede che
 * l'operatrice sceglie — e scritta per esteso nella migrazione
 * `20260912180100_transazione_voci_nuove.sql`, che chiude il paragrafo lasciando
 * alla schermata la decisione se dirlo. Si dice.
 *
 * IL FATTO: il movimento prende la sede del DOCUMENTO, mentre i due campi che
 * decidono la fatturazione (`pagamento_stato`, `fattura_stato`) il server li manda
 * soltanto a chi ha fra le proprie la sede del PAGAMENTO D'ANCORAGGIO. Quando le
 * due divergono, la riga compare nel filtro di sede di chi NON la può fatturare:
 * chip muto, nessuna casella del lotto, e niente che dica perché.
 *
 * MISURATO il 2026-09-13 sul database vivo, ed è ciò che stabilisce il perimetro:
 *  · 239 movimenti, 174 confermati, **0** con la sede del documento diversa da
 *    quella del proprio pagamento — il caso nasce col primo bonifico composto;
 *  · 855 famiglie, **4** con figli in sedi diverse, di cui **1 sola** con voci
 *    aperte in più di una sede: è quella che oggi lo produrrebbe. Raro, e la
 *    rarità è ciò che lo rende peggiore: un vuoto che si incontra una volta
 *    l'anno non genera un'abitudine, genera una segnalazione di guasto;
 *  · senza la guardia «nessun chip» l'avviso comparirebbe su **100 righe** per
 *    l'operatrice di Giugliano, 120 per Aversa, 128 per Cesa — tutte righe che
 *    dicono già «Fattura FPR …», perché i DOCUMENTI restano cross-sede per
 *    progetto. Con la guardia: 2, 3 e 1.
 */
describe('RiconciliazionePanel — la riga muta dice perché', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const SPIEGAZIONE = 'Il pagamento di questa riga è di un’altra sede: da qui non si può fatturare.';

  it('confermata, con pagamento, e i due campi derivati assenti → lo spiega', async () => {
    // È il fixture `BONIFICO QUATTRO`: `fattura: null` e nessuno dei due campi
    // derivati, cioè esattamente ciò che il server manda su una riga il cui
    // pagamento sta fuori dalle sedi di chi guarda.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO QUATTRO/)).toBeInTheDocument());

    expect(rigaDi('BONIFICO QUATTRO').textContent).toContain(SPIEGAZIONE);
  });

  it('non nomina nessun plesso: quel dato il browser non ce l’ha', async () => {
    // È precisamente ciò che il server gli ha tolto. Inventarlo vorrebbe dire dire
    // a una segreteria il nome di una sede che non ha modo di verificare.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO QUATTRO/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO QUATTRO').textContent ?? '';
    for (const sede of ['Giugliano', 'Aversa', 'Cesa']) expect(riga).not.toContain(sede);
  });

  it('se un DOCUMENTO parla, la riga non è muta: nessuna spiegazione di troppo', async () => {
    // La guardia che tiene l'avviso su 2 righe invece che su 100.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO UNO/)).toBeInTheDocument());

    expect(rigaDi('BONIFICO UNO').textContent).not.toContain(SPIEGAZIONE);
    expect(rigaDi('BONIFICO DUE').textContent).not.toContain(SPIEGAZIONE);
    // e nemmeno su quella della PROPRIA sede, che il chip giallo ce l'ha
    expect(rigaDi('BONIFICO TRE').textContent).not.toContain(SPIEGAZIONE);
    // una sola spiegazione su tutto l'elenco, non una per riga senza chip
    expect(screen.queryAllByText(SPIEGAZIONE)).toHaveLength(1);
  });

  it('la riga RIAPERTA dall’annullo conserva il pagamento e NON è di un’altra sede', async () => {
    // `annulla_transazione_contabile` riapre il movimento (`da_abbinare`) e gli
    // LASCIA `pagamento_id`. Senza la guardia sullo stato, ogni riga riaperta si
    // porterebbe addosso una spiegazione falsa — e sono righe che chiedono lavoro,
    // cioè quelle su cui una frase sbagliata costa di più.
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mr', data_operazione: '2026-09-13', importo: 120, causale: 'BONIFICO RIAPERTO', controparte: '', stato: 'da_abbinare', pagamento_id: 'pg-riaperto', suggerimenti: [{ pagamento_id: 'pg-riaperto', score: 900, motivi: ['importo esatto'], alunno_id: 'a1' }] },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO RIAPERTO/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO RIAPERTO').textContent ?? '';
    expect(riga).toContain('Da abbinare');
    expect(riga).not.toContain(SPIEGAZIONE);
    // e nemmeno il chip: il server non le attacca i documenti (`pagamentoAbbinatoDi`)
    expect(riga).not.toContain('Fattur');
  });

  it('propria sede, pagamento non saldato → si tace: il motivo NON è la sede', async () => {
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mp', data_operazione: '2026-09-13', importo: 90, causale: 'BONIFICO PARZIALE', controparte: '', stato: 'confermato', pagamento_id: 'pg-8', suggerimenti: [], fattura: { stato: 'da_fatturare', numeri: [] }, pagamento_stato: 'parziale', fattura_stato: 'non_richiesta' },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO PARZIALE/)).toBeInTheDocument());

    expect(rigaDi('BONIFICO PARZIALE').textContent).not.toContain(SPIEGAZIONE);
  });

  it('fatturazione NON disponibile → nessuna spiegazione: i campi mancano per un GUASTO', async () => {
    // Quando la batch dei pagamenti cade, il server manda i due campi `null` su
    // TUTTE le righe e lo DICHIARA. Scrivere lì «è di un’altra sede» sarebbe un
    // verdetto inventato sull'intero registro.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimenti, fatturazione_disponibile: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO QUATTRO/)).toBeInTheDocument());

    expect(screen.queryAllByText(SPIEGAZIONE)).toHaveLength(0);
  });

  it('l’inchiostro è quello del semaforo, non un grigio su fondo verde', async () => {
    // La riga confermata ha fondo VERDE PIENO: `text-kidville-sub` (giusto su
    // carta bianca, 6,46:1) lì scenderebbe sotto AA. Si eredita `SEMAFORO.sub`,
    // che è ciò che la causale usa già due righe sopra.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const nota = await screen.findByText(SPIEGAZIONE);

    expect(nota.className).toContain('text-kidville-white');
    expect(nota.className).not.toContain('text-kidville-muted');
    expect(nota.className).not.toContain('text-kidville-sub');
    expect(nota.className).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
