import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';
import { LottoFatturePanel } from '@/components/features/admin/pagamenti/LottoFatturePanel';
import type { MovimentoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';
import { ATTESA_FRA_BLOCCHI_MS, PAUSA_DOPO_RIFIUTO_LOCALE_MS, TETTO_BLOCCO, TETTO_LOTTO } from '@/lib/pagamenti/lotto-fatture';

/**
 * ─── «EMETTI TUTTE»: LA SELEZIONE MULTIPLA DELLA RICONCILIAZIONE ────────────
 *
 * Qui si collaudano le tre cose che rendono un lotto di fatture una funzione
 * invece che un incidente:
 *
 *  1. le POST partono **in sequenza**, mai in parallelo — Aruba concede un
 *     `signin` al minuto per IP, e dodici richieste insieme sono dodici `429`
 *     con dodici numeri di fattura consumati;
 *  2. al primo esito di TRASPORTO ignoto (502) il lotto **si ferma** e le righe
 *     rimaste risultano «non tentate», non «fallite»: sono due fatti diversi, e
 *     solo uno dei due si ripete premendo di nuovo;
 *  3. il PRE-VOLO non spende un colpo di quota: `GET …/anteprima` non parla con
 *     Aruba, e con un intestatario risolvibile su 130 è quello l'elenco che vale.
 *
 * ⚠️ TIMER FINTI. Il ritmo del lotto è 90 s da inizio a inizio: senza timer finti
 * questo file durerebbe minuti, e con un `waitFor` che li ignora sarebbe verde
 * anche su un lotto che spara tutto insieme.
 */

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>();
  return { ...vero, logClient: logSpy };
});

/** Tre bonifici confermati e saldati, mai fatturati: le sole righe selezionabili. */
const daFatturare = (n: number) => ({
  id: `m${n}`,
  data_operazione: `2026-10-0${n}`,
  importo: 100 + n,
  causale: `Bonifico retta ${n}`,
  controparte: '',
  stato: 'confermato',
  pagamento_id: `pg${n}`,
  pagamento_stato: 'pagato',
  fattura_stato: 'non_richiesta',
  // È ciò che il GET appende a ogni riga abbinata senza documenti a registro.
  fattura: { stato: 'da_fatturare', numeri: [] },
  suggerimenti: [],
});

/** Una riga già fatturata e una ancora da abbinare: NON devono avere la casella. */
const gia = {
  id: 'm9', data_operazione: '2026-10-09', importo: 200, causale: 'Retta fatturata', controparte: '',
  stato: 'confermato', pagamento_id: 'pg9', pagamento_stato: 'pagato', fattura_stato: 'emessa',
  fattura: { stato: 'emessa', numeri: ['FPR 1900/26'] }, suggerimenti: [],
};
const daAbbinare = {
  id: 'm8', data_operazione: '2026-10-08', importo: 60, causale: 'Mensa', controparte: '',
  stato: 'da_abbinare', pagamento_id: null, suggerimenti: [],
};

/**
 * ─── LE DUE RIGHE CHE IL CHIP DICE «DA FATTURARE» E IL SERVER NO ────────────
 *
 * `fatturaDaFare` risponde `true` su entrambe — il tono arriva dai DOCUMENTI
 * (`fattura.stato === 'scartata'`), che la rotta NON minimizza per sede — ma
 * nessuna delle due si può emettere:
 *
 *  · la prima è di un ALTRO plesso (i due campi derivati arrivano `null` per
 *    minimizzazione): l'emissione la respinge con `assertPagamentoInScope`;
 *  · la seconda è della propria sede ma NON è saldata: su un pagamento parziale
 *    la fattura non si emette, e l'emissione risponde 400 `non_saldato`.
 *
 * Il filtro «Da fatturare» del server pretende anche `pagamento_stato === 'pagato'`
 * (`filtraFattura` in `api/pagamenti/riconciliazione`): senza la stessa terza
 * condizione qui, la spunta sarebbe una SECONDA definizione di «da fatturare» —
 * che conta righe che il filtro non mostra e occupa con esse gli slot del tetto.
 */
const altraSedeScartata = {
  id: 'ms1', data_operazione: '2026-10-11', importo: 300, causale: 'Bonifico di un altro plesso', controparte: '',
  stato: 'confermato', pagamento_id: 'pgX', pagamento_stato: null, fattura_stato: null,
  fattura: { stato: 'scartata', numeri: [] }, suggerimenti: [],
};
const nonSaldataScartata = {
  id: 'ms2', data_operazione: '2026-10-12', importo: 400, causale: 'Bonifico non saldato', controparte: '',
  stato: 'confermato', pagamento_id: 'pgY', pagamento_stato: 'da_pagare', fattura_stato: 'scartata',
  fattura: { stato: 'scartata', numeri: [] }, suggerimenti: [],
};

/**
 * N righe da fatturare, tutte selezionabili: serve a esercitare il TETTO, che con
 * tre righe contro un tetto di dodici non si tocca mai.
 */
const molte = (n: number) =>
  Array.from({ length: n }, (_, k) => ({
    ...daFatturare(1),
    id: `x${k}`,
    pagamento_id: `pgx${k}`,
    data_operazione: `2026-11-${String(k + 1).padStart(2, '0')}`,
    importo: 500 + k,
    causale: `Bonifico lotto ${k}`,
  }));

const CONTEGGI = { da_fatturare: 3, fatturate: 1, parziale: false };

interface RispostaPost { stato: number; corpo: unknown }

/**
 * Il finto server. `postPerId` permette di far rifiutare UNA riga precisa: senza,
 * il caso «la seconda va storta» non sarebbe scrivibile.
 */
function stubFetch(opts: {
  movimenti?: unknown[];
  anteprimaPerId?: Record<string, unknown>;
  postPerId?: Record<string, RispostaPost>;
  /** Le righe che il server dichiara «già a registro» invece che emesse adesso. */
  giaPerId?: Record<string, boolean>;
  /** Fa fallire l'INTERA chiamata al blocco (504 di piattaforma, corpo illeggibile…). */
  bloccoStato?: RispostaPost;
  /** Quanto ci mette UNA anteprima: serve a interrompere il pre-volo A METÀ. */
  anteprimaRitardoMs?: number;
} = {}) {
  const movs = opts.movimenti ?? [daFatturare(1), daFatturare(2), daFatturare(3), gia, daAbbinare];
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes('/api/pagamenti/fattura/anteprima')) {
      if (opts.anteprimaRitardoMs) {
        await new Promise<void>((r) => { setTimeout(r, opts.anteprimaRitardoMs); });
      }
      const id = new URL(u, 'http://x').searchParams.get('pagamento_id') ?? '';
      const dati = opts.anteprimaPerId?.[id] ?? {
        causale: `Retta ottobre ${id}`,
        origine: 'modello',
        lunghezza: 20,
        limite: 100,
        eccede: false,
        intestatario: { alunno: null, quote: [{ adult_id: 'a1', label: 'unica', importo: 100, nome: 'Mario Rossi', fatturabile: true, errori: {} }], ripartito: false, candidati: [], proposta: null, ordinante: null },
      };
      return { ok: true, status: 200, json: async () => ({ success: true, data: dati }) };
    }
    if (u.includes('/api/pagamenti/fattura/lotto') && init?.method === 'POST') {
      // ⚠️ IL TRASPORTO È CAMBIATO IL 2026-09-07: una POST porta un BLOCCO di righe,
      // non una sola. Questo ramo riproduce la semantica vera della route — emesse,
      // già a registro, fallite, restanti, `fermato` — perché il pannello adesso deve
      // saper mappare una risposta collettiva su righe singole, ed è lì che può
      // sbagliare. Un finto server che rispondesse «va tutto bene» non collauderebbe
      // quella mappatura.
      if (opts.bloccoStato && opts.bloccoStato.stato !== 200) {
        const b = opts.bloccoStato;
        return { ok: false, status: b.stato, json: async () => b.corpo };
      }
      const righe = (JSON.parse(init.body ?? '{}') as { pagamenti?: { pagamento_id: string }[] }).pagamenti ?? [];
      const emesse: { pagamento_id: string; numero: number }[] = [];
      const giaEmesse: { pagamento_id: string }[] = [];
      const fallite: { pagamento_id: string; messaggio?: string; codice?: string; statoHttp?: number }[] = [];
      const restanti: string[] = [];
      let fermato: 'errore' | 'budget' | null = null;
      for (let i = 0; i < righe.length; i++) {
        const id = righe[i].pagamento_id;
        if (fermato) { restanti.push(id); continue; }
        const r = opts.postPerId?.[id];
        if (!r || (r.stato >= 200 && r.stato < 300)) {
          if (opts.giaPerId?.[id]) giaEmesse.push({ pagamento_id: id });
          else emesse.push({ pagamento_id: id, numero: 1900 + i });
          continue;
        }
        const corpo = r.corpo as { error?: string; codice?: string } | null;
        fallite.push({
          pagamento_id: id,
          messaggio: corpo?.error,
          codice: corpo?.codice,
          statoHttp: r.stato,
        });
        // Stessa regola della route: 0, 429 e ogni 5xx dicono che il problema è del
        // canale e non della riga, e il blocco si ferma.
        if (r.stato === 0 || r.stato === 429 || r.stato >= 500) fermato = 'errore';
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { emesse, gia_emesse: giaEmesse, fallite, restanti, fermato } }),
      };
    }
    if (u.includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: movs, fatturazione_disponibile: true, conteggi: CONTEGGI }) };
    }
    if (u.includes('/api/pagamenti?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

/** Avanza i timer finti E svuota la coda dei microtask, dentro `act`. */
async function avanza(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Ripete `avanza(0)` finché la condizione non si avvera (o si arrende dicendolo). */
async function finoA(cond: () => boolean, quante = 40) {
  for (let i = 0; i < quante; i++) {
    if (cond()) return;
    await avanza(0);
  }
  if (!cond()) throw new Error('la condizione attesa non si è mai avverata');
}

const post = (f: ReturnType<typeof stubFetch>) =>
  f.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');

/**
 * Seleziona TUTTE le righe e arriva alla conferma: serve ai casi che vogliono più di
 * UN BLOCCO.
 *
 * ⚠️ Dal 2026-09-07 il lotto parte a blocchi da `TETTO_BLOCCO`, quindi tre righe
 * selezionate sono UNA sola POST: l'attesa fra i blocchi, il progresso a metà lotto e
 * l'interruzione non esistono più con quel campione. I casi che li misurano devono
 * avere abbastanza righe da riempire due blocchi, altrimenti sono verdi su una
 * situazione che non si presenta mai.
 */
async function finoAllaConfermaMolte(f: ReturnType<typeof stubFetch>) {
  render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
  await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);
  fireEvent.click(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ }));
  await avanza(0);
  fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
  await finoA(() => screen.queryByText(/fatture pronte/) !== null, 400);
  return f;
}

/** Quante righe servono per avere esattamente DUE blocchi, il secondo non pieno. */
const DUE_BLOCCHI = TETTO_BLOCCO + 3;

/** Seleziona le righe indicate e arriva fino al pannello di conferma. */
async function finoAllaConferma(f: ReturnType<typeof stubFetch>, quali = ['m1', 'm2', 'm3']) {
  render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
  await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);
  for (const id of quali) {
    const n = id.replace('m', '');
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`\\(0${n}/10/2026\\)`) }));
  }
  fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
  await finoA(() => screen.queryByText(/fatture pronte|fattura pronta|Nessuna delle righe/) !== null);
  return f;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('la casella di selezione compare SOLO sulle righe da fatturare', () => {
  it('tre caselle per tre righe da fatturare, e nessuna sulle altre due', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    // Non una casella DISABILITATA sulle altre: nessuna casella affatto. Una
    // casella che non si può spuntare è un comando che non si sa perché non funziona.
    expect(screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })).toHaveLength(3);
    expect(screen.queryByRole('checkbox', { name: /09\/10\/2026/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /08\/10\/2026/ })).toBeNull();
  });

  it('il nome accessibile porta importo e data, MAI la causale (contiene il CF di un minore)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    const casella = screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ });
    const nome = casella.getAttribute('aria-label') ?? '';
    expect(nome).toContain('101,00');
    expect(nome).toContain('01/10/2026');
    expect(nome).not.toContain('Bonifico retta');
  });

  it('la casella è FRATELLO del bottone che apre il popup, mai dentro di esso', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    // Un <input> dentro un <button> è HTML non valido e rompe il bersaglio «apri».
    expect(container.querySelector('button input[type="checkbox"]')).toBeNull();
    const casella = screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ });
    expect(casella.closest('button')).toBeNull();
    expect(casella.closest('li')).not.toBeNull();
  });

  it('spuntare una casella non apre il popup del movimento', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('una riga di un ALTRO plesso col documento SCARTATO non ha casella', async () => {
    // Il chip dice «Scartata» — i documenti sono cross-sede per progetto — ma
    // l'emissione la respinge: `assertPagamentoInScope`. Se avesse la casella,
    // «Seleziona tutte le da fatturare» la conterebbe e le darebbe uno slot del
    // tetto, per mandarla poi contro un rifiuto.
    vi.stubGlobal('fetch', stubFetch({ movimenti: [altraSedeScartata] }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico di un altro plesso/) !== null);

    expect(screen.queryAllByRole('checkbox', { name: /Seleziona il bonifico/ })).toHaveLength(0);
    expect(screen.queryByText(/Seleziona tutte le da fatturare/)).toBeNull();
  });

  it('un pagamento NON saldato col documento scartato non ha casella', async () => {
    // Su un pagamento parziale la fattura non si emette (400 `non_saldato`), e
    // l'anteprima — che non ha nessuna guardia sul saldo — lo dichiarerebbe
    // «pronto»: il rifiuto arriverebbe solo dopo aver consumato il tentativo.
    vi.stubGlobal('fetch', stubFetch({ movimenti: [nonSaldataScartata] }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico non saldato/) !== null);

    expect(screen.queryAllByRole('checkbox', { name: /Seleziona il bonifico/ })).toHaveLength(0);
  });
});

describe('il TETTO si applica alla SELEZIONE, non al momento dell’emissione', () => {
  it('la spunta OLTRE IL TETTO è rifiutata: la selezione si ferma lì', async () => {
    // Troncare in silenzio al momento dell'emissione significherebbe non emettere
    // fatture che l'operatore crede partite. Qui il rifiuto è visibile: la casella
    // resta vuota e il conteggio in fondo alla barra non sale.
    //
    // ⚠️ Il tetto si IMPORTA. Dal 2026-09-07 vale 50 e non più 12, perché non è più
    // «quante ne partono alla volta» (quello è `TETTO_BLOCCO`) ma «quante se ne
    // possono mettere in coda»: il vincolo è il volume orario che Aruba concede.
    const f = stubFetch({ movimenti: molte(TETTO_LOTTO + 2) });
    vi.stubGlobal('fetch', f);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);

    const caselle = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ });
    expect(caselle).toHaveLength(TETTO_LOTTO + 2);
    for (const c of caselle.slice(0, TETTO_LOTTO + 1)) fireEvent.click(c);
    await avanza(0);

    const dopo = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ }) as HTMLInputElement[];
    expect(dopo.filter((c) => c.checked)).toHaveLength(TETTO_LOTTO);
    expect(dopo[TETTO_LOTTO].checked).toBe(false);
    expect(screen.getByText(`${TETTO_LOTTO} bonifici selezionati`)).toBeInTheDocument();
  });

  it('«Seleziona tutte» dichiara IL TETTO nell’etichetta, e ne spunta esattamente quel numero', async () => {
    const f = stubFetch({ movimenti: molte(TETTO_LOTTO + 2) });
    vi.stubGlobal('fetch', f);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);

    // Il numero fra parentesi è il TETTO, non quante righe ci sono: prometterne di
    // più e spuntarne meno sarebbe la stessa bugia del troncamento.
    const tutte = screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ });
    expect(tutte.getAttribute('aria-label') ?? tutte.closest('label')?.textContent).toContain(`(${TETTO_LOTTO})`);

    fireEvent.click(tutte);
    await avanza(0);
    const dopo = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ }) as HTMLInputElement[];
    expect(dopo.filter((c) => c.checked)).toHaveLength(TETTO_LOTTO);
    expect(screen.getByText(`${TETTO_LOTTO} bonifici selezionati`)).toBeInTheDocument();
  });

  it('la barra dichiara il tetto in italiano corretto', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    // Il ramo `other` è quello che si vede SEMPRE (il tetto è ben oltre uno): la
    // stringa è in permanenza sotto gli occhi di chi lavora.
    expect(screen.getByText(new RegExp(`Si emettono al massimo ${TETTO_LOTTO} fatture per volta`))).toBeInTheDocument();
  });
});

describe('la live region del lotto', () => {
  it('esiste, ed è VUOTA, prima che il lotto parta', async () => {
    // Un `role="status"` inserito nel DOM col contenuto già dentro resta muto su
    // NVDA e JAWS: dev'essere lo stesso nodo, montato vuoto e riempito dopo.
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    const live = screen.getByTestId('lotto-avanzamento');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');
  });
});

describe('il PRE-VOLO non spende quota: dice chi è pronto e chi no', () => {
  it('le righe senza intestatario fatturabile finiscono in «Da completare», non spariscono', async () => {
    const f = stubFetch({
      anteprimaPerId: {
        pg2: {
          causale: 'Retta ottobre pg2', origine: 'modello', lunghezza: 20, limite: 100, eccede: false,
          intestatario: { alunno: null, quote: [{ adult_id: null, label: 'unica', importo: 100, nome: '', fatturabile: false, errori: { codice_fiscale: 'mancante' } }], ripartito: false, candidati: [], proposta: null, ordinante: null },
        },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    expect(screen.getByText('2 fatture pronte')).toBeInTheDocument();
    expect(screen.getByText('1 riga da completare')).toBeInTheDocument();
    // e il pre-volo non ha toccato Aruba: nessuna POST
    expect(post(f)).toHaveLength(0);
  });

  it('la causale mostrata è quella dell’ANTEPRIMA, non una ricomposta nel browser', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f, ['m1']);
    // far approvare un documento e spedirne un altro si corregge solo con una
    // nota di variazione: il testo a schermo è byte per byte quello del server.
    expect(screen.getByText(/Retta ottobre pg1/)).toBeInTheDocument();
  });

  it('interrompere il pre-volo NON fa sparire le righe non ancora controllate', async () => {
    // Il pre-volo va a blocchi di quattro. Interrompendolo dopo il primo blocco,
    // le altre quattro righe non sono né «pronte» né «da completare»: senza questa
    // correzione il pannello diceva «4 pronte» su 8 selezionate, e le quattro
    // mancanti sparivano senza che nessun testo dicesse perché.
    const f = stubFetch({ movimenti: molte(8), anteprimaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);
    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) fireEvent.click(c);
    await avanza(0);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await avanza(0); // il primo blocco di quattro anteprime è in volo
    fireEvent.click(screen.getByRole('button', { name: 'Interrompi' }));
    await avanza(1_000);
    await finoA(() => screen.queryByText(/fatture pronte/) !== null);

    expect(screen.getByText('4 fatture pronte')).toBeInTheDocument();
    // 4 + 4 = 8, cioè le righe selezionate: nessuna è sparita per strada.
    expect(screen.getByText('4 righe da completare')).toBeInTheDocument();
    expect(screen.getAllByText(/Controllo interrotto/)).toHaveLength(4);
    expect(post(f)).toHaveLength(0);
  });
});

describe('il ciclo di emissione non sopravvive al pannello che lo mostra', () => {
  it('a lotto in corso le caselle sono BLOCCATE: la selezione non cambia sotto i piedi del ciclo', async () => {
    // Le caselle vivono nel pannello PADRE, e il lotto è montato su
    // `selezionati.size > 0`: togliere le spunte a lotto in corso smonterebbe la
    // barra lasciando il ciclo a emettere documenti fiscali senza interfaccia.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);

    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) {
      expect(c).toBeDisabled();
    }
    expect(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ })).toBeDisabled();
  });

  it('smontato il pannello, nessun BLOCCO nuovo parte — ma quello in volo esce lo stesso', async () => {
    // ⚠️ QUESTO CASO PROMETTE MENO DI PRIMA, E LA DIFFERENZA VA DETTA.
    //
    // Con una POST per riga, smontare il pannello fermava il ciclo prima del
    // documento successivo: al massimo usciva la fattura già in volo. Con il ciclo
    // sul server un blocco già partito **emette tutte le sue quindici fatture**, e
    // nessun gesto del browser lo ferma: la traccia resta a registro e nei log
    // invece che sullo schermo.
    //
    // Ciò che questo caso continua a garantire è l'altra metà, che vale ancora:
    // dopo lo smontaggio **nessun blocco NUOVO parte**. Il cleanup non può limitarsi
    // a cancellare il timer esistente — il ciclo, che sta risolvendo `res.json()`,
    // ne creerebbe uno nuovo dopo lo smontaggio e ripartirebbe.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    const selezionate = molte(DUE_BLOCCHI) as unknown as MovimentoUi[];
    const { unmount } = render(
      <LottoFatturePanel userId="u1" selezionate={selezionate} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fatture pronte/) !== null, 400);
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1, 200);

    unmount();
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    expect(post(f), 'il secondo blocco non deve partire senza nessuno che lo guardi').toHaveLength(1);
  });
});

describe('l’emissione: una alla volta, e ci si ferma quando serve', () => {
  it('diciotto selezionate → DUE blocchi, mai due in volo insieme', async () => {
    // ⚠️ QUESTO CASO ASSERIVA «tre POST in sequenza». Il lock era sul PARALLELO —
    // dodici POST insieme sarebbero dodici `429` con dodici numeri consumati — e
    // adesso vale per i blocchi: uno alla volta, e il secondo non parte finché
    // l'orologio non ha fatto passare l'attesa che serve al `signin`.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1, 200);
    // ⚠️ IL CUORE DEL CASO: senza avanzare l'orologio il secondo blocco NON parte.
    await avanza(0);
    expect(post(f)).toHaveLength(1);

    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await finoA(() => post(f).length === 2, 200);
    // Due blocchi e basta: le righe erano diciotto, quindici più tre.
    await avanza(ATTESA_FRA_BLOCCHI_MS * 3);
    expect(post(f)).toHaveLength(2);

    const primo = JSON.parse((post(f)[0][1] as { body: string }).body) as { pagamenti: Record<string, unknown>[] };
    const secondo = JSON.parse((post(f)[1][1] as { body: string }).body) as { pagamenti: Record<string, unknown>[] };
    expect(primo.pagamenti).toHaveLength(TETTO_BLOCCO);
    expect(secondo.pagamenti).toHaveLength(DUE_BLOCCHI - TETTO_BLOCCO);
    // ogni riga porta `causale: null`, mai il campo assente
    for (const riga of [...primo.pagamenti, ...secondo.pagamenti]) {
      expect('causale' in riga).toBe(true);
      expect(riga.causale).toBeNull();
    }
  });

  it('un 502 sulla seconda riga: il blocco si ferma, e la terza risulta «non tentata»', async () => {
    const f = stubFetch({
      postPerId: {
        pg2: {
          stato: 502,
          corpo: {
            error: 'Aruba non ha concluso l’invio della fattura FPR 1949/2026 (429) …',
            codice: 'FATTURA_TRASPORTO_IGNOTO',
          },
        },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);

    // ⚠️ Le tre righe stanno in UN blocco: il server le ha viste tutte e tre in una
    // chiamata sola e ha dichiarato `fermato: 'errore'` con la terza fra i restanti.
    // Il lock non è più «nessuna terza POST» ma «nessun SECONDO blocco»: nemmeno
    // un'ora di orologio ne fa partire un altro.
    await avanza(3_600_000);
    expect(post(f)).toHaveLength(1);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).getByText('1 fattura emessa')).toBeInTheDocument();
    // ⚠️ NON «saltata». Al 502 di trasporto il numero È STATO consumato e il
    // documento potrebbe essere partito: chiamarla «saltata» direbbe che per
    // quella riga non è successo niente — il contrario dell'alert qui sotto, e
    // un progressivo in meno per chi riconcilia col pannello Aruba.
    expect(within(riepilogo).getByText(/1 riga dall’esito ignoto/)).toBeInTheDocument();
    expect(within(riepilogo).queryByText(/riga saltata|righe saltate/)).toBeNull();
    expect(within(riepilogo).getByText('1 riga non tentata')).toBeInTheDocument();
    // il numero del documento consumato arriva dalla prosa del server: senza, non
    // si sa QUALE fattura andare a cercare sul pannello Aruba.
    // …UNA volta sola: la riga saltata non ripete il testo che sta nell'alert.
    expect(within(riepilogo).getAllByText(/FPR 1949\/2026/)).toHaveLength(1);
    expect(within(riepilogo).getByRole('alert').textContent).toContain('FPR 1949/2026');
    expect(within(riepilogo).getByText(/45 minuti/)).toBeInTheDocument();
  });

  it('«Interrompi» dopo il primo blocco: il secondo non parte', async () => {
    // ⚠️ COSA PROMETTE ADESSO «INTERROMPI», ed è meno di prima. Con una POST per
    // riga fermava prima del documento successivo. Adesso ferma **fra un blocco e
    // l'altro**: le quindici fatture del blocco in volo escono comunque. È il prezzo
    // dei sei minuti al posto di ottantasette, ed è scritto anche nel pannello.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1, 200);

    // Lo stesso nodo DOM del pulsante primario: non un secondo bottone che
    // appare (il focus si perderebbe), ma la stessa casella che cambia mestiere.
    fireEvent.click(screen.getByRole('button', { name: 'Interrompi' }));
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    expect(post(f)).toHaveLength(1);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).getByText(`${TETTO_BLOCCO} fatture emesse`)).toBeInTheDocument();
    expect(within(riepilogo).getByText(`${DUE_BLOCCHI - TETTO_BLOCCO} righe non tentate`)).toBeInTheDocument();
  });

  it('durante il lotto il pulsante primario È «Interrompi», e alla fine «Chiudi»', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f, ['m1']);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);
    expect(screen.queryByRole('button', { name: /Emetti ora/ })).toBeNull();

    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument();
    // il focus finisce sull'intestazione del riepilogo, non sul body
    expect(document.activeElement).toBe(screen.getByTestId('lotto-riepilogo-titolo'));
  });

  it('nei log del lotto entrano solo conteggi e stato: mai una causale, mai un nome', async () => {
    const f = stubFetch({
      postPerId: { pg2: { stato: 502, corpo: { error: 'fattura FPR 1949/2026 …', codice: 'FATTURA_TRASPORTO_IGNOTO' } } },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);
    await avanza(0);

    const righe = logSpy.mock.calls.map(([e]) => JSON.stringify(e));
    expect(righe.length).toBeGreaterThan(0);
    for (const r of righe) {
      expect(r).not.toContain('Retta ottobre');
      expect(r).not.toContain('Mario Rossi');
      expect(r).not.toContain('Bonifico retta');
    }
  });
});

describe('la selezione è CONGELATA dal pre-volo fino alla fine del lotto', () => {
  it('in fase di conferma le caselle sono BLOCCATE: la lista misurata non può cambiare sotto', async () => {
    // Il pre-volo MISURA una lista e il pannello di conferma la mostra riga per
    // riga: da quel momento «ciò che si vede» e «ciò che partirà» sono la stessa
    // cosa, e restano tali solo se la selezione non si può più toccare. Il blocco
    // valeva per `controllo` e `corso` e si apriva proprio in mezzo — nell'unica
    // fase in cui la lista è già decisa e il ciclo non è ancora partito.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);
    expect(screen.getByText('3 fatture pronte')).toBeInTheDocument();

    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) {
      expect(c).toBeDisabled();
    }
    expect(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ })).toBeDisabled();
    // L'uscita c'è, ed è dichiarata: si annulla tutto e si ricomincia.
    expect(screen.getByRole('button', { name: 'Annulla selezione' })).toBeInTheDocument();
  });

  it('ciò che esce dal lotto è ciò che il piè di pagina dichiara, anche provando a cambiare idea dopo il controllo', async () => {
    // IL DIFETTO, prima di questa correzione: in `conferma` la terza casella era
    // ancora cliccabile e toglierla NON toglieva la riga dal lotto — `esegui()`
    // emette da `pronte`, congelato al pre-volo. Il piè di pagina scriveva
    // «2 bonifici selezionati» mentre il pulsante diceva «Emetti ora (3)», e ne
    // uscivano 3: tre documenti fiscali per due righe selezionate, e nessuna
    // schermata che dichiarasse la divergenza.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    // ⚠️ `HTMLElement.click()` e non `fireEvent.click`: il primo È il gesto vero —
    // la specifica dice che su un controllo di modulo DISABILITATO non fa niente,
    // e jsdom la rispetta. `fireEvent` invece spara l'evento a mano e la casella
    // si spunterebbe lo stesso: sarebbe un test che misura una cosa che nel
    // browser non può succedere.
    await act(async () => { screen.getByRole('checkbox', { name: /\(03\/10\/2026\)/ }).click(); });

    expect(screen.getByText('3 bonifici selezionati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emetti ora (3)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);
    await avanza(ATTESA_FRA_BLOCCHI_MS);

    // Le tre righe stanno in un blocco solo: quel che conta è che siano ESATTAMENTE
    // le tre misurate al pre-volo, nell'ordine, e nessun'altra.
    const corpo = JSON.parse((post(f)[0][1] as { body: string }).body) as { pagamenti: { pagamento_id: string }[] };
    expect(corpo.pagamenti.map((r) => r.pagamento_id)).toEqual(['pg1', 'pg2', 'pg3']);
  });
});

describe('«mi fermo?» e «il numero è in dubbio?» sono DUE domande', () => {
  it('un 503 ferma il lotto ma NON dichiara nessun numero consumato', async () => {
    // I 503 di `src/lib/aruba/emissione.ts` nascono tutti PRIMA del `signin`
    // (Aruba non configurata, cedente incompleto, una lettura caduta): nessun
    // numero è stato allocato e sul pannello Aruba non c'è niente da cercare. È
    // anche l'esito più probabile del primo lotto vero — se la sede non è
    // configurata, il 503 esce sulla prima riga.
    const f = stubFetch({
      postPerId: {
        pg1: {
          stato: 503,
          corpo: { error: 'Fatturazione Aruba non configurata o credenziali mancanti', data: { motivo: 'non_configurato' } },
        },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);
    await avanza(3_600_000);
    expect(post(f)).toHaveLength(1); // il lotto si ferma comunque: il predicato largo resta largo

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).queryByText(/esito ignoto/)).toBeNull();
    expect(within(riepilogo).getByText('1 riga saltata')).toBeInTheDocument();
    expect(within(riepilogo).getByText('2 righe non tentate')).toBeInTheDocument();
    const alert = within(riepilogo).getByRole('alert').textContent ?? '';
    expect(alert).toContain('Nessun numero di fattura è stato consumato');
    expect(alert).not.toContain('pannello Aruba');
  });
});

describe('la barra annuncia l’attesa VERA, non sempre novanta secondi', () => {
  it('un blocco tutto respinto dai NOSTRI gate costa cinque secondi, non l’attesa piena', async () => {
    // ⚠️ IL CASO È CAMBIATO CON IL TRASPORTO, ed è più insidioso di prima. Con una
    // POST per riga bastava lo status: `pausaDopo(409, …)` valeva 5.000 ms perché ad
    // Aruba non era partito niente. Adesso la POST del blocco risponde **200** anche
    // quando tutte e quindici le righe sono state respinte da un gate nostro — e
    // fidarsi dello status annuncerebbe l'attesa piena a chi non ha toccato Aruba.
    const respinteTutte = Object.fromEntries(
      Array.from({ length: TETTO_BLOCCO }, (_, k) => [
        `pgx${k}`,
        { stato: 409, corpo: { error: 'Per questo pagamento esiste già una fattura viva.' } },
      ]),
    );
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI), postPerId: respinteTutte });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => (screen.getByTestId('lotto-avanzamento').textContent ?? '').includes('attendo'), 200);

    const testo = screen.getByTestId('lotto-avanzamento').textContent ?? '';
    expect(testo).toContain('~5 s');
    expect(testo).not.toContain(`~${ATTESA_FRA_BLOCCHI_MS / 1000} s`);

    // …e l'attesa piena resta quella vera quando il blocco ad Aruba ci è andato davvero.
    await avanza(PAUSA_DOPO_RIFIUTO_LOCALE_MS);
    await finoA(() => post(f).length === 2, 200);
  });
});

/**
 * ─── DICIOTTO MINUTI DAVANTI A UNA RIGA DI TESTO ────────────────────────────
 *
 * MISURATO sullo screenshot del 2026-09-07: durante il lotto il pannello diceva
 * soltanto «Fattura 1/3 · invio in corso». Con dodici fatture sono **circa
 * diciotto minuti** (12 × 90 s, il ritmo del `signin` di Aruba) davanti a una riga
 * che si muove una volta ogni novanta secondi: si legge come un blocco, e chi la
 * legge così ricarica la pagina — perdendo di vista quali documenti fiscali siano
 * già partiti. E le fatture concluse comparivano solo nel riepilogo finale.
 */
describe('l’attesa si vede, si spiega e si misura', () => {
  it('la barra si riempie in proporzione alle fatture CONCLUSE', async () => {
    // Servono DUE blocchi: con uno solo la barra andrebbe da zero a tutto in un
    // colpo, e «si riempie in proporzione» non sarebbe osservabile.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    // Prima di premere non c'è nessuna barra: non c'è niente che avanzi.
    expect(screen.queryByTestId('lotto-barra')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-barra') !== null, 200);
    // Il primo blocco è IN VOLO: concluso non lo è ancora, e la barra non deve mentire.
    expect(screen.getByTestId('lotto-barra').getAttribute('data-concluse')).toBe('0');

    await finoA(() => screen.getByTestId('lotto-barra').getAttribute('data-concluse') === String(TETTO_BLOCCO), 200);
    const barra = screen.getByTestId('lotto-barra');
    expect(barra.getAttribute('data-totale')).toBe(String(DUE_BLOCCHI));
    // Riempita per davvero, non solo contata.
    expect((barra.firstElementChild as HTMLElement).style.width).toBe(`${(TETTO_BLOCCO / DUE_BLOCCHI) * 100}%`);
  });

  it('la barra è MUTA per lo screen reader: a dire il numero è già il `role="status"`', async () => {
    // Una delle due, non tutte e due a raccontare la stessa cosa. Il `role="status"`
    // dice «Fattura 2/3», più la ragione dell'attesa e quanto manca: è più di
    // quanto un `aria-valuenow` possa dire, e arriva da solo.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-barra') !== null);

    const barra = screen.getByTestId('lotto-barra');
    expect(barra.getAttribute('aria-hidden')).toBe('true');
    expect(barra.getAttribute('role'), 'o decorativa o progressbar: mai le due cose').toBeNull();
  });

  it('la live region dice QUANTO MANCA, non solo a che punto è', async () => {
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));

    // Appena partito: diciotto righe sono due blocchi, cioè due durate di blocco più
    // un'attesa fra i due. Il numero esce dal modulo puro, qui si legge tradotto.
    await finoA(() => (screen.getByTestId('lotto-avanzamento').textContent ?? '').includes('minuti'), 200);
    expect(screen.getByTestId('lotto-avanzamento').textContent).toContain('circa 3 minuti alla fine');
  });

  it('LA RAGIONE DELL’ATTESA c’era già, e resta: «attendo il ritmo di Aruba»', async () => {
    // Non è un difetto nuovo: la frase esisteva, e lo screenshot aveva colto
    // l'istante dell'INVIO — che dura pochi secondi — invece dei novanta della pausa.
    // L'attesa esiste solo FRA due blocchi: con uno solo non c'è niente da attendere.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));

    await finoA(() => (screen.getByTestId('lotto-avanzamento').textContent ?? '').includes('attendo'), 200);
    expect(screen.getByTestId('lotto-avanzamento').textContent).toContain('attendo il ritmo di Aruba');
  });

  it('la live region resta LO STESSO NODO: montata vuota, riempita dopo', async () => {
    // Un `role="status"` inserito nel DOM col contenuto già dentro resta muto su
    // NVDA e JAWS. I blocchi nuovi (elenco in corso, barra) le stanno attorno: se
    // uno di loro la facesse rimontare, la barra parlerebbe a nessuno.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);
    const prima = screen.getByTestId('lotto-avanzamento');
    expect(prima.textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => (screen.getByTestId('lotto-avanzamento').textContent ?? '') !== '', 200);
    expect(screen.getByTestId('lotto-avanzamento'), 'la live region è stata rimontata').toBe(prima);

    // …e resta lo stesso anche dopo che l'elenco «già uscito» è comparso e il
    // riepilogo finale gli è nato accanto. I timer vanno avanzati a mano: il ritmo è
    // da inizio a inizio di BLOCCO, e `finoA` svuota i microtask, non l'orologio.
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await finoA(() => post(f).length === 2, 200);
    await avanza(ATTESA_FRA_BLOCCHI_MS);
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null, 200);
    expect(screen.getByTestId('lotto-avanzamento')).toBe(prima);
  });
});

describe('durante il lotto si vede CHE COSA è già uscito', () => {
  it('il numero della prima fattura si legge PRIMA della fine, non solo nel riepilogo', async () => {
    // L'operatore non sapeva se qualcosa fosse andato: le righe concluse comparivano
    // solo alla fine, cioè quando non servono più. Con i blocchi il primo esito arriva
    // dopo il primo blocco, ed è quello che questo caso guarda.
    const f = stubFetch({ movimenti: molte(DUE_BLOCCHI) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-in-corso-esiti') !== null, 200);

    const inCorso = screen.getByTestId('lotto-in-corso-esiti');
    expect(within(inCorso).getByText(`${TETTO_BLOCCO} fatture emesse`)).toBeInTheDocument();
    expect(within(inCorso).getByText(/Fattura n\. 1900/)).toBeInTheDocument();
    // …e il riepilogo finale non c'è ancora: il lotto sta ancora girando
    expect(screen.queryByTestId('lotto-riepilogo')).toBeNull();
  });

  it('anche le righe SALTATE si vedono mentre il lotto gira, col loro motivo', async () => {
    const f = stubFetch({
      movimenti: molte(DUE_BLOCCHI),
      postPerId: { pgx0: { stato: 409, corpo: { error: 'Per questo pagamento esiste già una fattura viva.' } } },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte(f);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-in-corso-esiti') !== null, 200);

    const inCorso = screen.getByTestId('lotto-in-corso-esiti');
    // Un 409 nasce dai NOSTRI gate: riguarda quella riga e non ferma il blocco, che
    // infatti prosegue con le altre quattordici.
    expect(within(inCorso).getByText('1 riga saltata')).toBeInTheDocument();
    expect(within(inCorso).getByText(/esiste già una fattura viva/)).toBeInTheDocument();
  });

  it('a lotto finito l’elenco in corso sparisce: a raccontare resta il riepilogo', async () => {
    // Due elenchi della stessa cosa nello stesso pannello sarebbero due verità da
    // tenere allineate, ed è il difetto che il riepilogo esiste per non avere.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f, ['m1']);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    expect(screen.queryByTestId('lotto-in-corso-esiti')).toBeNull();
  });
});

describe('il piè di pagina dice ciò che serve ALLA FASE in cui si trova', () => {
  it('a lotto FINITO non conta più i selezionati e non ripete il tetto delle 12', async () => {
    // MISURATO sullo screenshot: «3 bonifici selezionati · Si emettono al massimo
    // 12 fatture per volta» compariva anche sotto il riepilogo finale, dove il
    // lotto è finito e non c'è più niente da emettere. È rumore su una schermata
    // che va letta.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f, ['m1']);

    // …e prima di premere quelle due frasi ci sono davvero: senza questa riga il
    // test sarebbe verde anche su un piè di pagina sparito del tutto.
    expect(screen.getByText('1 bonifico selezionato')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    expect(screen.queryByText(/bonifico selezionato|bonifici selezionati/)).toBeNull();
    expect(screen.queryByText(/Si emettono al massimo/)).toBeNull();
    // Il comando per uscire, invece, resta.
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument();
  });

  it('il tetto si dichiara solo dove si può ancora scegliere', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);
    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    expect(screen.getByText(new RegExp(`Si emettono al massimo ${TETTO_LOTTO} fatture per volta`))).toBeInTheDocument();

    // In `conferma` la selezione è congelata: il tetto non è più una regola che
    // riguarda un gesto possibile.
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    expect(screen.queryByText(/Si emettono al massimo/)).toBeNull();
  });
});

describe('«3 selezionati» accanto a «Emetti ora (2)» va SPIEGATO, non dedotto', () => {
  it('quando le pronte sono meno dei selezionati, una frase lega i due numeri', async () => {
    // I fatti sono giusti — 3 selezionati, 2 pronte, 1 da completare — ma due
    // numeri diversi a pochi centimetri, senza una parola che li leghi, si leggono
    // come un errore del programma. E chi li legge così non preme.
    const f = stubFetch({
      anteprimaPerId: {
        pg3: {
          causale: 'Retta ottobre pg3', origine: 'modello', lunghezza: 20, limite: 100, eccede: false,
          intestatario: { alunno: null, quote: [{ adult_id: null, label: 'unica', importo: 100, nome: '', fatturabile: false, errori: { codice_fiscale: 'mancante' } }], ripartito: false, candidati: [], proposta: null, ordinante: null },
        },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);

    expect(screen.getByText('3 bonifici selezionati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emetti ora (2)' })).toBeInTheDocument();
    expect(screen.getByText(/Si emettono solo le righe pronte: 1 resta da completare e non parte/))
      .toBeInTheDocument();
  });

  it('quando i due numeri COINCIDONO la frase non c’è: non c’è niente da spiegare', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma(f);
    expect(screen.getByRole('button', { name: 'Emetti ora (3)' })).toBeInTheDocument();
    expect(screen.queryByText(/Si emettono solo le righe pronte/)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LA PROPOSTA DEL BONIFICO ENTRA NEL LOTTO
//
// L'emissione singola sa dire «questo bonifico l'ha fatto Rossi Maria, e Rossi
// Maria è la mamma»; il lotto buttava via quella proposta e scartava la riga con
// «manca l'intestatario». Ora la usa — ma non in silenzio: quel nome non l'ha
// scelto nessuno, e una fattura elettronica sbagliata si corregge solo con una
// nota di variazione.
// ─────────────────────────────────────────────────────────────────────────────
describe('il lotto usa la proposta, e la fa confermare', () => {
  const CON_PROPOSTA = {
    causale: 'Retta ottobre',
    origine: 'modello',
    lunghezza: 20, limite: 100, eccede: false,
    intestatario: {
      alunno: null,
      // nessuna quota fatturabile: senza la proposta questa riga sarebbe scartata
      quote: [{ adult_id: null, label: 'unica', importo: 100, nome: '', fatturabile: false, errori: {} }],
      ripartito: false,
      candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', relazione: 'madre', fatturabile: true, errori: {} }],
      proposta: { adult_id: 'a-1', motivo: 'bonifico_esatto' },
      ordinante: 'ROSSI MARIA',
    },
  };

  it('una riga che prima era «da completare» diventa pronta, e dice CHI e PERCHÉ', async () => {
    const f = stubFetch({ movimenti: [daFatturare(1)], anteprimaPerId: { pg1: CON_PROPOSTA } });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);

    expect(screen.getByText(/Intestate su proposta del bonifico/i)).toBeTruthy();
    // due volte, ed è giusto: «Intestata a: Rossi Maria» e la frase che spiega
    // il perché, «Bonifico di ROSSI MARIA: il nome corrisponde…»
    expect(screen.getAllByText(/Rossi Maria/).length).toBeGreaterThanOrEqual(2);
    // il «perché» è la frase della SINGOLA, non un doppione scritto per il lotto
    expect(screen.queryByText(/manca l’intestatario/i)).toBeNull();
  });

  it('senza la spunta il lotto NON parte, e lo dice invece di restare zitto', async () => {
    const f = stubFetch({ movimenti: [daFatturare(1)], anteprimaPerId: { pg1: CON_PROPOSTA } });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);

    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    // sincrono di proposito: con i timer finti un `findBy` aspetterebbe un orologio
    // che qui nessuno fa girare — e la mancata partenza è immediata, non attesa
    expect(screen.getByRole('alert').textContent).toMatch(/spunta/i);
    expect(post(f)).toHaveLength(0);
    // il pulsante primario NON si è disabilitato: il fuoco resta dov'è
    expect((screen.getByRole('button', { name: /Emetti ora/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('con la spunta parte, e la POST porta l’intestatario proposto', async () => {
    const f = stubFetch({ movimenti: [daFatturare(1)], anteprimaPerId: { pg1: CON_PROPOSTA } });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);

    // ⚠️ IL CORPO ADESSO PORTA UN BLOCCO, non una riga: lo stesso giorno il lotto è
    // passato dal browser al server (`/api/pagamenti/fattura/lotto`). Ciò che questo
    // caso misura NON cambia — l'intestatario proposto deve arrivare nella POST — ma
    // vive dentro `pagamenti[0]`. Se si fosse riallineato guardando solo il primo
    // livello, il campo sarebbe risultato `undefined` e qualcuno avrebbe potuto
    // concludere che la proposta non serviva più.
    const corpo = JSON.parse(String(post(f)[0]![1]!.body));
    expect(corpo.pagamenti).toHaveLength(1);
    expect(corpo.pagamenti[0].intestatario).toEqual({ tipo: 'adult', adult_id: 'a-1' });
    // `causale: null` resta: è ciò che toglie la correzione manuale appiccicosa
    expect(corpo.pagamenti[0].causale).toBe(null);
  });

  it('una riga già emettibile per anagrafica non chiede nessuna spunta', async () => {
    const f = stubFetch({ movimenti: [daFatturare(1)] });     // anteprima di default: quota fatturabile
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Emetti ora/ }));
    await finoA(() => post(f).length === 1);
    expect(JSON.parse(String(post(f)[0]![1]!.body)).intestatario).toBeUndefined();
  });

  it('un pagamento ripartito resta fuori, e ora dice il motivo VERO', async () => {
    const ripartito = {
      ...CON_PROPOSTA,
      intestatario: { ...CON_PROPOSTA.intestatario, ripartito: true },
    };
    const f = stubFetch({ movimenti: [daFatturare(1)], anteprimaPerId: { pg1: ripartito } });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/ripartito/i) !== null);
    // «manca l'intestatario» qui sarebbe falso: gli intestatari sono due, ed è voluto
    expect(screen.getByText(/ripartito fra due genitori/i)).toBeTruthy();
  });
});
