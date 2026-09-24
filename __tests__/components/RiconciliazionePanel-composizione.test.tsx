import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';
import type { EsitoComposizione, MovimentoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';
import type { PrecompilaTransazione } from '@/components/features/admin/pagamenti/TransazioniPanel';

/**
 * ─── QUELLO CHE IL PANNELLO FA QUANDO IL POPUP SI CHIUDE BENE ────────────────
 *
 * Fino al 2026-09-13 faceva una cosa sola: ricaricare. Da qui in avanti ne fa due,
 * e la seconda è un RIEPILOGO di ciò che è stato registrato — «Pagamento
 * registrato: 3 voci e 20 ticket · € 150,00». Su una composizione, che salda voci
 * di più fratelli e accredita ticket dentro una transazione atomica, «la riga è
 * diventata verde» è il minimo comune denominatore fra «ha fatto tutto» e «ha
 * fatto metà».
 *
 * ⚠️ PERCHÉ IL POPUP È FINTO QUI, E SOLO QUI. `MovimentoDialog` è la fetta di un
 * altro esecutore e in questo stesso branch sta cambiando: montarlo vero
 * legherebbe questi test al suo stato d'avanzamento, e un test che diventa rosso
 * perché è cambiato il file accanto non dice niente su questo file. Il finto
 * espone le TRE porte del contratto — `onDone(esito)`, `onDone()` senza esito e
 * `onIncassoUnico(movimento)` — e nient'altro: è il confine che il pannello deve
 * rispettare, non una copia del popup.
 *
 * ⚠️ E IL FINTO HA UN CONTROLLO NEGATIVO. Il pulsante «senza esito» esiste apposta:
 * un mock che chiama sempre `onDone(esito)` sarebbe verde anche se il pannello
 * mostrasse il riepilogo SEMPRE, cioè anche dopo una conferma qualunque. Con
 * entrambe le porte, la differenza fra «riepilogo» e «nessun riepilogo» è misurata.
 *
 * Il finto espone anche `ChipCoda` (consegna 2b), perché il pannello lo importa: vitest
 * lancia «No "ChipCoda" export is defined on the mock» appena lo si legge. Non è una porta
 * del contratto del popup, e qui non si prova (lo prova `RiconciliazionePanel-fattura`).
 */

/** L'esito che la rotta `…/componi` restituisce, come il popup lo consegna. */
const ESITO: EsitoComposizione = { voci: 3, ticket: 20, totale: 150 };

/** Registra i movimenti su cui il finto popup è stato aperto (per il rimbalzo). */
interface FintoProps {
  movimento: MovimentoUi;
  onDone: (esito?: EsitoComposizione) => void;
  onClose: () => void;
  onIncassoUnico?: (m: MovimentoUi) => void;
}

const esitoCorrente = vi.hoisted(() => ({ valore: null as EsitoComposizione | null }));

vi.mock('@/components/features/admin/pagamenti/MovimentoDialog', () => ({
  ChipFatturazione: ({ fat }: { fat: { labelKey: string } }) => <span>{fat.labelKey}</span>,
  ChipCoda: () => null,
  MovimentoDialog: ({ movimento, onDone, onClose, onIncassoUnico }: FintoProps) => (
    <div role="dialog" aria-label="finto popup">
      <button type="button" onClick={() => { onDone(esitoCorrente.valore ?? undefined); onClose(); }}>
        composizione riuscita
      </button>
      <button type="button" onClick={() => { onDone(); onClose(); }}>azione senza esito</button>
      {onIncassoUnico && (
        <button type="button" onClick={() => onIncassoUnico(movimento)}>rimbalza a incasso unico</button>
      )}
    </div>
  ),
}));

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

/**
 * Un bonifico multi-CF: due agganci per codice fiscale su alunni DISTINTI. È la
 * condizione che accende «Incasso unico», e senza di essa il rimbalzo non si
 * potrebbe nemmeno provare.
 */
const MOVIMENTI = [
  {
    id: 'm1', data_operazione: '2026-09-10', importo: 150, causale: 'BONIFICO FAMIGLIA',
    controparte: 'ORDINANTE', stato: 'da_abbinare', pagamento_id: null,
    suggerimenti: [
      { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1' },
      { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a2' },
    ],
  },
];

const APERTI = [{ id: 'pa1', descrizione: 'Retta', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Nome', cognome: 'Cognome' } }];

/** Le sole GET dell'ELENCO: il conteggio (`?conteggi=1`) è un'altra domanda. */
const getElenco = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter(([u]) => String(u).includes('/api/pagamenti/riconciliazione') && !String(u).includes('conteggi=1'));

function stubFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/pagamenti/pagante-comune')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { parent_id: 'parent-9' } }) };
    }
    if (u.includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: MOVIMENTI, fatturazione_disponibile: true, conteggi: { da_fatturare: 2, fatturate: 1, parziale: false } }) };
    }
    if (u.includes('/api/pagamenti?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: APERTI }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

/** Apre il finto popup sulla riga del bonifico. */
async function apriIlPopup() {
  await waitFor(() => expect(screen.getByText(/BONIFICO FAMIGLIA/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/BONIFICO FAMIGLIA/).closest('button')!);
  await screen.findByRole('dialog');
}

describe('RiconciliazionePanel — dopo la composizione', () => {
  beforeEach(() => { esitoCorrente.valore = ESITO; });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('mostra il riepilogo di ciò che è stato registrato, coi numeri e l’importo', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    // La frase INTERA, non un pezzo: «3 voci» da solo passerebbe anche se
    // l'importo o i ticket finissero nel posto sbagliato.
    const riepilogo = await screen.findByText('Pagamento registrato: 3 voci e 20 ticket · € 150,00');
    expect(riepilogo).toBeInTheDocument();
    // `role="status"`: chi non vede lo schermo deve sentirlo senza andarlo a cercare.
    expect(riepilogo.closest('[role="status"]')).not.toBeNull();
  });

  it('ricarica l’elenco: una GET nuova, oltre a quella del montaggio', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();
    const prima = getElenco(fetchMock).length;

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    await waitFor(() => expect(getElenco(fetchMock).length).toBeGreaterThan(prima));
  });

  it('senza esito NON si inventa nessun riepilogo — ma la ricarica avviene lo stesso', async () => {
    // È il controllo negativo del mock: se il pannello mostrasse il riepilogo a
    // ogni `onDone`, questo test sarebbe l'unico a vederlo.
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();
    const prima = getElenco(fetchMock).length;

    fireEvent.click(screen.getByRole('button', { name: 'azione senza esito' }));

    await waitFor(() => expect(getElenco(fetchMock).length).toBeGreaterThan(prima));
    expect(screen.queryByText(/Pagamento registrato/)).toBeNull();
  });

  it('movimento NON legato: il riepilogo cambia tono e dice di non ripetere', async () => {
    // Il denaro è scritto, la riga bancaria no. Un banner verde qui sarebbe la
    // bugia peggiore: l'operatrice ricomporrebbe, e sulle voci nuove e sui ticket
    // il secondo giro crea righe nuove.
    esitoCorrente.valore = { voci: 2, ticket: 0, totale: 80, movimentoLegato: false };
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    // `role="alert"` e non `status`: qui c'è qualcosa da fare, non da sapere.
    const fascia = await screen.findByRole('alert');
    // I numeri ci sono ANCORA — l'incasso è avvenuto davvero, e nasconderlo
    // lascerebbe l'operatrice senza sapere che cosa è stato scritto…
    expect(fascia.textContent).toContain('Pagamento registrato: 2 voci · € 80,00');
    // …ma accanto c'è la frase che dice di non rifarlo, quella che la route
    // dichiara col codice `CONCILIAZIONE_MOVIMENTO_NON_LEGATO`.
    expect(fascia.textContent).toContain('non ripetere l’operazione');
    // e nessuna pelle da conferma riuscita sotto un avviso
    expect(fascia.className).not.toContain('kidville-success');
    // il verde di «tutto a posto» non deve esistere affatto in questo caso
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('RiconciliazionePanel — il rimbalzo a «Incasso unico» resta', () => {
  beforeEach(() => { esitoCorrente.valore = ESITO; });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('risolve il pagante comune e apre il wizard precompilato', async () => {
    const apri = vi.fn<(p: PrecompilaTransazione) => void>();
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" onIncassoUnico={apri} />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'rimbalza a incasso unico' }));

    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    /**
     * ⚠️ `toEqual` E NON `toMatchObject`, ed è il punto di questo test.
     *
     * Il rimbalzo perde l'id del movimento, e la domanda «va aggiunto?» ha una
     * RISPOSTA MISURATA, del 2026-09-13: no. `PrecompilaTransazione` dichiara
     * quattro campi e `TransazioniPanel` li destruttura tutti e quattro senza
     * leggerne altri; `POST /api/pagamenti/transazioni` non ha nessun campo per il
     * movimento nella sua `zod`, e il payload che manda alla RPC non porta
     * `movimento_id` — cioè «Incasso unico» non saprebbe che farsene, e un campo
     * che viaggia e non legge nessuno è decorazione da mantenere.
     *
     * Un confronto esatto è ciò che rende quella decisione RIESAMINABILE: chi un
     * giorno vorrà passare l'id troverà questo test rosso e con accanto la misura
     * da rifare, invece di aggiungere un campo che nessuno riceve.
     */
    expect(apri.mock.calls[0][0]).toEqual({
      parent: 'parent-9',
      rif: 'BONIFICO FAMIGLIA',
      tot: 150,
      alunni: ['a1', 'a2'],
    });
  });

  it('se il pagante non si risolve si apre lo stesso, allo step «scegli pagante»', async () => {
    const apri = vi.fn<(p: PrecompilaTransazione) => void>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/pagamenti/pagante-comune')) {
        return { ok: false, status: 500, json: async () => ({ success: false }) };
      }
      if (u.includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: MOVIMENTI, fatturazione_disponibile: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: APERTI }) };
    }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" onIncassoUnico={apri} />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'rimbalza a incasso unico' }));

    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    expect(apri.mock.calls[0][0].parent).toBeNull();
    // Totale e riferimento restano: è la degradazione graziosa, non un ripiego vuoto.
    expect(apri.mock.calls[0][0].tot).toBe(150);
  });
});

/**
 * ─── UN SUCCESSO DICHIARATO SUL NULLA ────────────────────────────
 *
 * Rilievo misurato dal critico di questa fetta: con un esito MALFORMATO la fascia
 * usciva verde e diceva «Pagamento registrato: 0 voci · € 0,00».
 *
 * LA STRADA SCELTA È L'AVVISO, NON IL SILENZIO, e la ragione va detta perché l'altra
 * era altrettanto difendibile. `onDone(esito)` lo chiama SOLO il ramo in cui la
 * rotta ha risposto bene: quando i numeri sono illeggibili, il denaro è scritto
 * lo stesso. Nascondere la fascia toglierebbe alla segreteria l'unica conferma che
 * il pagamento è stato registrato — e il pericolo dichiarato di questa schermata è
 * proprio che lei ricomponga: sulle voci nuove e sui ticket il secondo giro crea
 * righe nuove, e non c'è nessun residuo che la fermi. Il silenzio, qui, è più
 * pericoloso di un avviso.
 *
 * La distinzione che la frase deve reggere: «la scrittura è fallita» — che non è
 * questo caso, e non deve sembrarlo — contro «la scrittura è riuscita ma il
 * riepilogo è illeggibile».
 */
describe('RiconciliazionePanel — esito malformato', () => {
  beforeEach(() => { esitoCorrente.valore = ESITO; });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('numeri illeggibili: avviso, mai il verde con «0 voci · € 0,00»', async () => {
    esitoCorrente.valore = { voci: Number.NaN, ticket: -4, totale: Number.NaN };
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    const fascia = await screen.findByRole('alert');
    // La frase intera: dice che il pagamento c'è (non rifarlo) e che il dettaglio no.
    expect(fascia.textContent).toContain(
      'Pagamento registrato, ma il riepilogo di che cosa copre è arrivato illeggibile. Non ricomporre il bonifico: il denaro è già a registro. Controlla le voci della famiglia.',
    );
    // I numeri ripuliti NON si mostrano: sono lo zero della ripulitura, non un fatto.
    expect(screen.queryByText(/0 voci/)).toBeNull();
    expect(screen.queryByText(/Pagamento registrato: /)).toBeNull();
    // Nessuna pelle da conferma riuscita, e nessun `role="status"` accanto.
    expect(fascia.className).not.toContain('kidville-success');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('l’elenco si ricarica lo stesso: il denaro è scritto, la lista deve rileggerlo', async () => {
    esitoCorrente.valore = { voci: Number.NaN, ticket: -4, totale: Number.NaN };
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();
    const prima = getElenco(fetchMock).length;

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    await waitFor(() => expect(getElenco(fetchMock).length).toBeGreaterThan(prima));
  });

  it('e il controllo positivo: l’esito vero resta verde', async () => {
    // Senza questa riga, una fascia che finisse SEMPRE in avviso passerebbe il test
    // qui sopra e spegnerebbe la conferma su ogni composizione riuscita.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await apriIlPopup();

    fireEvent.click(screen.getByRole('button', { name: 'composizione riuscita' }));

    expect(await screen.findByText('Pagamento registrato: 3 voci e 20 ticket · € 150,00')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
