import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { IntlMessageFormat } from 'intl-messageformat';
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';
import { formatEuro } from '@/lib/format/valuta';
import { formatData } from '@/lib/i18n/date';
import type { MovimentoUi, PagamentoApertoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';

/**
 * ─── A CHE COSA È ASSOCIATO QUESTO BONIFICO, E COME SI SCOLLEGA (2026-10-05) ──
 *
 * Il popup di un movimento CONFERMATO sapeva dire lo stato della fattura della voce
 * àncora e basta: non la voce, non il bambino, non chi aveva confermato. E aveva un
 * solo comando, «Riapri», che stornava l'incasso SENZA dire che cosa avrebbe stornato.
 *
 * Adesso:
 *  · una lettura sola, `GET /api/pagamenti/riconciliazione/{id}`, porta l'associazione
 *    intera (voci, bambini, denaro per voce, chi ha confermato) e lo stato/fattura
 *    della voce àncora che prima arrivavano da `/api/pagamenti/{pagamento_id}`;
 *  · «Riapri» diventa DUE comandi — «Modifica associazione» ed «Elimina associazione» —
 *    e tutt'e due passano da una CONFERMA che elenca le conseguenze (storni, ricevuta,
 *    note di credito, coda fatture) prima di farle;
 *  · «Elimina» sceglie il destino della riga: di nuovo da abbinare, o ignorata;
 *  · «Modifica» non chiude il popup: lo riapre sulla STESSA riga, ora libera.
 *  · su un movimento IGNORATO resta un comando solo, «Rimetti da abbinare», senza
 *    conferma: non c'è nessun incasso da stornare.
 *
 * Dati SINTETICI: uuid finti e nomi inventati (il repo è pubblico).
 */

const CATALOGO_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>;
const PAGAMENTI_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/pagamenti.json'), 'utf8'),
) as Record<string, string>;
const SHARED_IT = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/shared.json'), 'utf8'),
) as Record<string, string>;
const testo = (chiave: string): string => CATALOGO_IT[chiave] ?? `adminContabilita.${chiave}`;
/** Il testo ICU come lo rende `test/setup.ts`: stesso motore, stessi valori. */
const testoIcu = (chiave: string, valori: Record<string, unknown>): string =>
  String(new IntlMessageFormat(testo(chiave), 'it').format(valori));
const dataBreve = (d: string) => formatData(d, 'it', 'breve');

/** FatturaButton fa fetch proprie: stub per isolare il dialog. */
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <button type="button">Emetti fattura</button>,
}));

const aperti: PagamentoApertoUi[] = [
  { id: 'pa1', descrizione: 'Iscrizione', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Tina', cognome: 'Blu' } },
];

const confermato: MovimentoUi = {
  id: 'm1',
  data_operazione: '2026-09-05',
  importo: 150,
  causale: 'BONIFICO RETTA',
  controparte: 'Ordinante Finto',
  stato: 'confermato',
  suggerimenti: [],
  pagamento_id: 'pg1',
  confermato_il: '2026-09-06T10:00:00Z',
};

const ignorato: MovimentoUi = { ...confermato, stato: 'ignorato', pagamento_id: null, confermato_il: null };

type Voce = Record<string, unknown>;
const voce = (extra: Voce = {}): Voce => ({
  pagamento_id: 'pg1',
  descrizione: 'Retta ottobre',
  alunno: 'Mara Bianchi',
  scuola_id: 'sc-1',
  importo_voce: 300,
  incassato_qui: 150,
  stato_voce: 'parziale',
  fattura_stato: null,
  fattura_in_coda: null,
  ...extra,
});

const associazione = (extra: Record<string, unknown> = {}) => ({
  tipo: 'singola',
  automatico: false,
  confermato_il: '2026-09-06T10:00:00Z',
  confermato_da: 'Anna Verdi',
  voci: [voce()],
  ...extra,
});

/** La risposta della GET, nella forma della rotta (`data.associazione` + `data.pagamento`). */
const lettura = (assoc: unknown = associazione(), pagamento: unknown = { stato: 'parziale', fattura_stato: null }) => ({
  success: true,
  data: { id: 'm1', stato: 'confermato', importo: 150, data_operazione: '2026-09-05', associazione: assoc, pagamento },
});

type Risposta = { ok: boolean; status: number; json: () => Promise<unknown> };
const risposta = (status: number, corpo: unknown): Risposta => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => corpo,
});

/**
 * Il server visto dal popup. Distingue la LETTURA dalla PATCH — stessa URL, metodi
 * diversi — e registra il corpo di ogni PATCH già decodificato: le asserzioni sono
 * sul `poi` che parte davvero, non su una stringa ricomposta a mano.
 */
function server(opz: { lettura?: () => Risposta; patch?: () => Risposta } = {}) {
  const chiamate: { url: string; metodo: string; corpo?: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const metodo = init?.method ?? 'GET';
    chiamate.push({ url: String(url), metodo, corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    if (metodo === 'PATCH') {
      return (opz.patch ?? (() => risposta(200, {
        success: true,
        data: { stato: 'da_abbinare', transazione_annullata: false, movimenti_riaperti: 1, incassi_stornati: 1 },
      })))();
    }
    if (String(url).includes('/api/pagamenti/riconciliazione/m1')) {
      return (opz.lettura ?? (() => risposta(200, lettura())))();
    }
    return risposta(404, {});
  });
  return {
    fetchMock,
    letture: () => chiamate.filter((c) => c.metodo === 'GET'),
    patch: () => chiamate.filter((c) => c.metodo === 'PATCH'),
  };
}

const ref = () => createRef<HTMLButtonElement>();

/**
 * Il comando, quando si può premere. I due pulsanti nascono disabilitati finché la
 * lettura è in volo: un `fireEvent.click` su un pulsante disabilitato non fa nulla, e
 * il test misurerebbe il proprio anticipo invece del componente.
 */
async function comandoPronto(nome: string) {
  const b = await screen.findByRole('button', { name: nome });
  await waitFor(() => expect(b).toBeEnabled());
  return b;
}

/** La conferma annidata: il dialogo che porta il titolo dello scollegamento. */
const conferma = (modo: 'Modifica' | 'Elimina') =>
  screen.findByRole('dialog', { name: testo(`scollegaTitolo${modo}`) });

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — «Associato a»: la lettura dell’associazione', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('voce SINGOLA: bambino, voce, quanto ha messo il bonifico, stato e chi ha confermato', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(testo('movdlgAssociatoA'))).toBeInTheDocument();
    expect(await screen.findByText('Mara Bianchi · Retta ottobre')).toBeInTheDocument();
    expect(screen.getByText(testoIcu('movdlgAssociatoIncassato', { incassato: formatEuro(150), totale: formatEuro(300) }))).toBeInTheDocument();
    expect(screen.getByText(PAGAMENTI_IT.statoParziale)).toBeInTheDocument();
    expect(screen.getByText(testoIcu('movdlgAssociatoConfermatoDa', { nome: 'Anna Verdi', data: dataBreve('2026-09-06T10:00:00Z') }))).toBeInTheDocument();
  });

  it('la lettura è UNA, ed è quella della riga bancaria — non più `/api/pagamenti/{pagamento_id}`', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await screen.findByText('Mara Bianchi · Retta ottobre');
    // Un giro di eventi in più: un effetto che rilegge a ogni render salirebbe a 2.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.letture().map((c) => c.url)).toEqual(['/api/pagamenti/riconciliazione/m1?userId=u1']);
  });

  it('stato e fattura della voce àncora arrivano da `data.pagamento`: il riquadro Documenti li legge', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione(), { stato: 'pagato', fattura_stato: 'emessa' })) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    // «Fatturata» nasce solo da `pagato` + `emessa`: senza leggere `data.pagamento`
    // il riquadro resterebbe a «Disponibile a saldo avvenuto».
    expect(await screen.findByText('Fatturata')).toBeInTheDocument();
  });

  it('una marca automatica si dice tale, con la data', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ automatico: true, confermato_da: null }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(testoIcu('movdlgAssociatoAutomatico', { data: dataBreve('2026-09-06T10:00:00Z') }))).toBeInTheDocument();
  });

  it('senza operatore leggibile: «Confermato il …», non un nome inventato', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ confermato_da: null }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(testoIcu('movdlgAssociatoConfermatoIl', { data: dataBreve('2026-09-06T10:00:00Z') }))).toBeInTheDocument();
  });

  it('nessuna voce: lo dice', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ voci: [] }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(testo('movdlgAssociatoNessuna'))).toBeInTheDocument();
  });

  it('una voce di un’ALTRA sede si dice tale: niente nome, niente «null» a schermo, le cifre sì', async () => {
    const s = server({
      lettura: () => risposta(200, lettura(associazione({
        tipo: 'composita',
        voci: [voce(), voce({ pagamento_id: 'pg2', descrizione: null, alunno: null, fuori_sede: true, scuola_id: 'sc-2', importo_voce: 80, incassato_qui: 80, stato_voce: 'pagato' })],
      }))),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    const { container } = render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByText(testo('movdlgAssociatoAltraSede'))).toBeInTheDocument();
    expect(screen.getByText(testoIcu('movdlgAssociatoIncassato', { incassato: formatEuro(80), totale: formatEuro(80) }))).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bnull\b/);
  });

  it('GET in 500: un avviso, e i comandi restano (la riapertura non dipende dalla lettura)', async () => {
    const s = server({ lettura: () => risposta(500, { error: 'Errore', codice: 'MOVIMENTO_NON_LETTO' }) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(testo('movdlgAssociatoErrore'));
    await comandoPronto(testo('movdlgModificaAssociazione'));
    await comandoPronto(testo('movdlgEliminaAssociazione'));
    // «Non ho potuto guardare» non diventa «non c'è niente».
    expect(screen.queryByText(testo('movdlgAssociatoNessuna'))).toBeNull();
  });

  it('un corpo che non si legge (200 non-JSON) è un errore, non un elenco vuoto', async () => {
    const s = server({ lettura: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(testo('movdlgAssociatoErrore'));
    expect(screen.queryByText(testo('movdlgAssociatoNessuna'))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — «Riapri» è diventato «Modifica» ed «Elimina associazione»', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('su un confermato: i due comandi nuovi, e «Riapri» non c’è più', async () => {
    vi.stubGlobal('fetch', server().fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    await comandoPronto(testo('movdlgModificaAssociazione'));
    await comandoPronto(testo('movdlgEliminaAssociazione'));
    expect(screen.queryByRole('button', { name: testo('movdlgRiapri') })).toBeNull();
  });

  it('«Elimina associazione» apre la conferma con lo storno, e senza conferma non parte niente', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));

    const dlg = await conferma('Elimina');
    expect(within(dlg).getByText(testo('scollegaIntro'))).toBeInTheDocument();
    expect(within(dlg).getByText(testoIcu('scollegaStorno', {
      voce: 'Retta ottobre', alunno: 'Mara Bianchi', importo: formatEuro(150),
    }))).toBeInTheDocument();
    // Voce singola: nessuna voce composta e nessuna ricevuta della transazione.
    expect(within(dlg).queryByText(testo('scollegaVociComposte'))).toBeNull();
    expect(within(dlg).queryByText(testo('scollegaRicevuta'))).toBeNull();
    // «Elimina» non promette di scegliere la voce giusta: quello è di «Modifica».
    expect(within(dlg).queryByText(testo('scollegaDopoModifica'))).toBeNull();
    // Il destino predefinito è «torna da abbinare».
    expect(within(dlg).getByRole('radio', { name: testo('scollegaDestinoDaAbbinare') })).toBeChecked();
    expect(within(dlg).getByRole('radio', { name: testo('scollegaDestinoIgnorato') })).not.toBeChecked();
    expect(s.patch()).toEqual([]);
  });

  it('«Elimina» → «viene segnato come ignorato» → la PATCH porta `poi: ignorato`, e l’esito lo dice', async () => {
    const s = server({
      patch: () => risposta(200, {
        success: true,
        data: { stato: 'ignorato', ignorato: true, transazione_annullata: false, movimenti_riaperti: 1, incassi_stornati: 1 },
      }),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));
    const dlg = await conferma('Elimina');
    fireEvent.click(within(dlg).getByRole('radio', { name: testo('scollegaDestinoIgnorato') }));
    fireEvent.click(within(dlg).getByRole('button', { name: testo('scollegaConferma') }));

    expect(await screen.findByText(testo('movdlgEsitoIgnorato'))).toBeInTheDocument();
    expect(s.patch()).toHaveLength(1);
    expect(s.patch()[0].url).toContain('/api/pagamenti/riconciliazione/m1');
    expect(s.patch()[0].corpo).toEqual({ azione: 'riapri', poi: 'ignorato' });
    expect(onDone).toHaveBeenCalled();
    // La conferma si è chiusa: resta solo il popup, col suo esito.
    expect(screen.queryByRole('dialog', { name: testo('scollegaTitoloElimina') })).toBeNull();
  });

  it('«Elimina» col destino predefinito: `poi: da_abbinare`, mai `ignorato`', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));
    fireEvent.click(within(await conferma('Elimina')).getByRole('button', { name: testo('scollegaConferma') }));

    await screen.findByText(testo('reconComponiEsitoRiaperto'));
    expect(s.patch()[0].corpo).toEqual({ azione: 'riapri', poi: 'da_abbinare' });
  });

  it('l’«ignora» non applicato e le richieste di fattura tolte arrivano all’operatrice', async () => {
    const s = server({
      patch: () => risposta(200, {
        success: true,
        data: { stato: 'da_abbinare', ignorato: false, richieste_fattura_tolte: 2, movimenti_riaperti: 1, incassi_stornati: 1 },
      }),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));
    const dlg = await conferma('Elimina');
    fireEvent.click(within(dlg).getByRole('radio', { name: testo('scollegaDestinoIgnorato') }));
    fireEvent.click(within(dlg).getByRole('button', { name: testo('scollegaConferma') }));

    expect(await screen.findByText(testo('movdlgEsitoIgnoraNonApplicato'))).toBeInTheDocument();
    expect(screen.getByText(testoIcu('movdlgEsitoCodaTolte', { n: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(testo('movdlgEsitoIgnorato'))).toBeNull();
  });

  it('«Annulla» nella conferma: nessuna PATCH, e il popup resta com’era', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));
    fireEvent.click(within(await conferma('Elimina')).getByRole('button', { name: testo('scollegaAnnulla') }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: testo('scollegaTitoloElimina') })).toBeNull());
    expect(s.patch()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    // Àncora positiva: il popup è ancora quello del confermato, coi suoi comandi.
    expect(screen.getByRole('button', { name: testo('movdlgEliminaAssociazione') })).toBeInTheDocument();
  });

  it('una fattura EMESSA sulla voce: la conferma lo dice prima (nota di credito)', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ voci: [voce({ fattura_stato: 'emessa' })] }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));

    const dlg = await conferma('Elimina');
    expect(within(dlg).getByText(testoIcu('scollegaFatturaEmessa', { voce: 'Retta ottobre' }))).toBeInTheDocument();
  });

  it('una richiesta di fattura IN CODA (o in errore) si dice; una in invio no', async () => {
    const s = server({
      lettura: () => risposta(200, lettura(associazione({
        tipo: 'composita',
        voci: [
          voce({ fattura_in_coda: 'in_coda' }),
          voce({ pagamento_id: 'pg2', descrizione: 'Mensa ottobre', fattura_in_coda: 'errore' }),
          voce({ pagamento_id: 'pg3', descrizione: 'Gita', fattura_in_coda: 'in_invio' }),
        ],
      }))),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));

    const dlg = await conferma('Elimina');
    expect(within(dlg).getByText(testoIcu('scollegaFatturaInCoda', { voce: 'Retta ottobre' }))).toBeInTheDocument();
    expect(within(dlg).getByText(testoIcu('scollegaFatturaInCoda', { voce: 'Mensa ottobre' }))).toBeInTheDocument();
    expect(within(dlg).queryByText(testoIcu('scollegaFatturaInCoda', { voce: 'Gita' }))).toBeNull();
    // Composita: le voci composte e la ricevuta.
    expect(within(dlg).getByText(testo('scollegaVociComposte'))).toBeInTheDocument();
    expect(within(dlg).getByText(testo('scollegaRicevuta'))).toBeInTheDocument();
  });

  it('nella conferma la voce di un’ALTRA sede non ha nome: «Voce di un’altra sede»', async () => {
    const s = server({
      lettura: () => risposta(200, lettura(associazione({
        tipo: 'composita',
        voci: [voce(), voce({ pagamento_id: 'pg2', descrizione: null, alunno: null, fuori_sede: true, scuola_id: 'sc-2', importo_voce: 80, incassato_qui: 80, fattura_stato: 'emessa' })],
      }))),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));

    const dlg = await conferma('Elimina');
    const altra = testo('movdlgAssociatoAltraSede');
    expect(within(dlg).getByText(testoIcu('scollegaStorno', { voce: altra, alunno: '—', importo: formatEuro(80) }))).toBeInTheDocument();
    expect(within(dlg).getByText(testoIcu('scollegaFatturaEmessa', { voce: altra }))).toBeInTheDocument();
    // Parola intera: «annullata» (la ricevuta) contiene «null» e non è un difetto.
    expect(dlg.textContent).not.toMatch(/\bnull\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — «Modifica associazione» riapre il popup sulla stessa riga', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('conferma → PATCH senza «ignora», e il pannello riceve la riga ora libera', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    const onRiapertoPerModifica = vi.fn();
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={onClose} onDone={onDone} returnFocusRef={ref()} onRiapertoPerModifica={onRiapertoPerModifica} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    const dlg = await conferma('Modifica');
    expect(within(dlg).getByText(testo('scollegaDopoModifica'))).toBeInTheDocument();
    // «Modifica» non sceglie un destino: la riga torna libera per essere riabbinata.
    expect(within(dlg).queryAllByRole('radio')).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole('button', { name: testo('scollegaConferma') }));

    await waitFor(() => expect(onRiapertoPerModifica).toHaveBeenCalledTimes(1));
    expect(onRiapertoPerModifica).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', stato: 'da_abbinare', confermato_il: null }));
    expect(s.patch()[0].corpo?.azione).toBe('riapri');
    expect(s.patch()[0].corpo?.poi).not.toBe('ignorato');
    expect(onClose).not.toHaveBeenCalled();
    // La lista la rilegge il pannello quando riapre il popup: `onDone` qui sarebbe la
    // seconda lettura della stessa lista per lo stesso gesto.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('senza `onRiapertoPerModifica` si comporta come «Elimina»: esito a schermo e lista riletta', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    fireEvent.click(within(await conferma('Modifica')).getByRole('button', { name: testo('scollegaConferma') }));

    expect(await screen.findByText(testo('reconComponiEsitoRiaperto'))).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
  });

  it('una riapertura FALLITA non riapre il popup: l’errore resta dov’è', async () => {
    const s = server({ patch: () => risposta(500, { error: 'Errore interno' }) });
    vi.stubGlobal('fetch', s.fetchMock);
    const onRiapertoPerModifica = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onRiapertoPerModifica={onRiapertoPerModifica} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    fireEvent.click(within(await conferma('Modifica')).getByRole('button', { name: testo('scollegaConferma') }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onRiapertoPerModifica).not.toHaveBeenCalled();
  });

  /**
   * ─── IL VICOLO CIECO DELLA FATTURA EMESSA (revisione finale, 2026-10-05) ─────
   *
   * La riapertura CONSERVA `pagamento_id`, e il riabbinamento su una voce diversa
   * passa dalla guardia `BONIFICO_GIA_FATTURATO`, che rifiuta con 409 finché sulla
   * voce di prima c'è una fattura viva. «Modifica» su una voce con fattura emessa
   * stornava, e poi non riusciva a riabbinare: l'incasso perso, la riga sospesa.
   * Decisione: la guardia resta; è «Modifica» che non parte, e dice perché.
   * «Elimina» invece si fa (la decisione n. 17: si riapre sempre, avvisando).
   */
  it('fattura EMESSA sulla voce: «Modifica» dice perché non si può e «Conferma» non parte', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ voci: [voce({ fattura_stato: 'emessa' })] }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    const onRiapertoPerModifica = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} onRiapertoPerModifica={onRiapertoPerModifica} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    const dlg = await conferma('Modifica');

    const avviso = within(dlg).getByRole('alert');
    expect(avviso).toHaveTextContent(testoIcu('scollegaModificaBloccataFattura', { voce: 'Retta ottobre' }));
    const ok = within(dlg).getByRole('button', { name: testo('scollegaConferma') });
    expect(ok).toBeDisabled();
    // «Subito dopo scegli la voce giusta» accanto a un divieto direbbe il contrario.
    expect(within(dlg).queryByText(testo('scollegaDopoModifica'))).toBeNull();
    fireEvent.click(ok);
    expect(s.patch()).toEqual([]);
    expect(onRiapertoPerModifica).not.toHaveBeenCalled();
  });

  it('la voce bloccata di un’ALTRA sede si dice «Voce di un’altra sede», mai per nome', async () => {
    const s = server({
      lettura: () => risposta(200, lettura(associazione({
        tipo: 'composita',
        voci: [voce(), voce({ pagamento_id: 'pg2', descrizione: null, alunno: null, fuori_sede: true, scuola_id: 'sc-2', fattura_stato: 'emessa' })],
      }))),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    const dlg = await conferma('Modifica');

    expect(within(dlg).getByRole('alert')).toHaveTextContent(
      testoIcu('scollegaModificaBloccataFattura', { voce: testo('movdlgAssociatoAltraSede') }),
    );
    expect(within(dlg).getByRole('button', { name: testo('scollegaConferma') })).toBeDisabled();
  });

  it('fattura EMESSA ma «Elimina»: nessun blocco, si riapre avvisando (decisione n. 17)', async () => {
    const s = server({ lettura: () => risposta(200, lettura(associazione({ voci: [voce({ fattura_stato: 'emessa' })] }))) });
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgEliminaAssociazione')));
    const dlg = await conferma('Elimina');

    expect(within(dlg).queryByText(testoIcu('scollegaModificaBloccataFattura', { voce: 'Retta ottobre' }))).toBeNull();
    const ok = within(dlg).getByRole('button', { name: testo('scollegaConferma') });
    expect(ok).toBeEnabled();
    fireEvent.click(ok);
    await waitFor(() => expect(s.patch()).toHaveLength(1));
  });

  it('nessuna fattura emessa: «Modifica» resta confermabile e senza avviso', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetchMock);
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    const dlg = await conferma('Modifica');

    expect(within(dlg).getByRole('button', { name: testo('scollegaConferma') })).toBeEnabled();
    expect(within(dlg).queryByRole('alert')).toBeNull();
  });

  /**
   * Una riapertura per «Modifica» che torna con un AVVISO (fatture non verificate,
   * fattura viva) non riapre il popup in abbinamento: lì l'avviso sparirebbe sotto
   * la ricerca delle voci. Si racconta come per «Elimina», e la lista si rilegge.
   */
  it('«Modifica» che torna con un avviso: niente riabbinamento, l’esito e l’avviso a schermo', async () => {
    const s = server({
      patch: () => risposta(200, {
        success: true,
        data: { stato: 'da_abbinare', transazione_annullata: false, movimenti_riaperti: 1, incassi_stornati: 1 },
        avviso: { codice: 'RIAPERTURA_FATTURE_NON_VERIFICATE', messaggio: 'non verificate', numeri: [] },
      }),
    });
    vi.stubGlobal('fetch', s.fetchMock);
    const onRiapertoPerModifica = vi.fn();
    const onDone = vi.fn();
    render(<MovimentoDialog movimento={confermato} aperti={aperti} userId="u1" onClose={() => {}} onDone={onDone} returnFocusRef={ref()} onRiapertoPerModifica={onRiapertoPerModifica} />);

    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    fireEvent.click(within(await conferma('Modifica')).getByRole('button', { name: testo('scollegaConferma') }));

    expect(await screen.findByText(SHARED_IT.erroreRiaperturaFattureNonVerificate)).toBeInTheDocument();
    expect(screen.getByText(testo('reconComponiEsitoRiaperto'))).toBeInTheDocument();
    expect(onRiapertoPerModifica).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('MovimentoDialog — un movimento IGNORATO si rimette da abbinare, senza conferma', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('«Rimetti da abbinare» manda la PATCH `riapri` nuda, e nessuna lettura dell’associazione', async () => {
    const s = server({ patch: () => risposta(200, { success: true }) });
    vi.stubGlobal('fetch', s.fetchMock);
    const onClose = vi.fn();
    render(<MovimentoDialog movimento={ignorato} aperti={aperti} userId="u1" onClose={onClose} onDone={() => {}} returnFocusRef={ref()} />);

    fireEvent.click(await comandoPronto(testo('movdlgRimettiDaAbbinare')));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(s.patch().map((c) => c.corpo)).toEqual([{ azione: 'riapri' }]);
    expect(s.letture()).toEqual([]);
    expect(screen.queryByRole('dialog', { name: testo('scollegaTitoloElimina') })).toBeNull();
    expect(screen.queryByRole('button', { name: testo('movdlgEliminaAssociazione') })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * IL PANNELLO POSSIEDE `selezionato`, e quindi è lui a riaprire il popup. Senza
 * questa prova il cablaggio di `onRiapertoPerModifica` (e la `key` che rimonta il
 * dialog sulla stessa riga con lo stato nuovo) non lo guarderebbe nessuno: il test
 * del dialog qui sopra chiama un finto.
 */
describe('RiconciliazionePanel — «Modifica associazione» riapre il popup in abbinamento', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('dopo la conferma il popup NON si chiude: è la stessa riga, ora da abbinare', async () => {
    const riga = { ...confermato, causale: 'BONIFICO DA RIABBINARE' };
    const patch: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === 'PATCH') {
        patch.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        return risposta(200, { success: true, data: { stato: 'da_abbinare', movimenti_riaperti: 1, incassi_stornati: 1 } });
      }
      if (u.includes('/api/pagamenti/riconciliazione/m1')) return risposta(200, lettura());
      if (u.includes('/api/pagamenti/riconciliazione')) return risposta(200, { success: true, data: [riga] });
      return risposta(200, { success: true, data: aperti });
    }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);

    fireEvent.click(await screen.findByText(/BONIFICO DA RIABBINARE/));
    fireEvent.click(await comandoPronto(testo('movdlgModificaAssociazione')));
    fireEvent.click(within(await conferma('Modifica')).getByRole('button', { name: testo('scollegaConferma') }));

    // La riga è la stessa, ma ora è libera: il popup mostra l'abbinamento.
    expect(await screen.findByText(testo('movdlgCercaAltroPagamento'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: testo('movdlgEliminaAssociazione') })).toBeNull();
    expect(patch).toHaveLength(1);
    expect(patch[0].azione).toBe('riapri');
  });
});
