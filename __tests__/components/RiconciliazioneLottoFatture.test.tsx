import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';
import { LottoFatturePanel } from '@/components/features/admin/pagamenti/LottoFatturePanel';
import type { MovimentoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui';
import { TETTO_LOTTO } from '@/lib/pagamenti/lotto-fatture';
import sharedIt from '../../messages/it/shared.json';

/**
 * ─── «EMETTI TUTTE»: LA SELEZIONE MULTIPLA DELLA RICONCILIAZIONE ────────────
 *
 * Qui si collaudano le cose che rendono un lotto di fatture una funzione invece
 * che un incidente:
 *
 *  1. il PRE-VOLO non spende un colpo di quota: `GET …/anteprima` non parla con
 *     Aruba, e le righe non pronte finiscono in «da completare» col motivo;
 *  2. la proposta del bonifico si usa, ma solo dopo una SPUNTA esplicita;
 *  3. dal 2026-09-23 (nucleo della coda fatture) il lotto NON EMETTE: fa UNA
 *     `POST /api/pagamenti/fattura/coda` con le righe confermate, e a inviare è il
 *     lavoratore sul server. Nessuna POST a `/fattura/lotto`, nessun blocco
 *     pilotato dal browser, nessuna attesa fra blocchi.
 *
 * ⚠️ I CASI DEI BLOCCHI SONO STATI TOLTI, NON RILASSATI. Fino al 2026-09-22 questo
 * file misurava la barra di avanzamento, la stima dei minuti, i 65 s fra due
 * blocchi, «Interrompi» fra un blocco e l'altro, il 502 di trasporto e il 503 di
 * blocco. Erano la misura di un ciclo che non esiste più: quelle garanzie adesso
 * vivono sul server (`src/lib/pagamenti/esegui-blocco-fatture.ts`, collaudato da
 * `__tests__/api/fattura-lotto.test.ts` e `__tests__/lib/fatture-coda/`).
 *
 * ⚠️ TIMER FINTI. Servono al pre-volo (anteprime in ritardo, interrotte a metà) e
 * alla POST in volo: con un `waitFor` che li ignora un'assenza sarebbe verde prima
 * che la risposta arrivi.
 */

/**
 * ⚠️ UN MOCK DI next-intl LOCALE, che risolve le chiavi PUNTATE.
 *
 * Quello globale di `test/setup.ts` legge `gruppo[key]`, cioè un accesso piatto: le
 * chiavi nuove della coda stanno sotto `codaFatture.lotto.*`, e con l'accesso piatto
 * ognuna tornerebbe il proprio nome — ogni asserzione sui testi della schermata finale
 * sarebbe verde su una stringa che nessun utente legge. Per il resto fa ESATTAMENTE ciò
 * che fa il globale: tutti i cataloghi italiani, e la formattazione ICU solo quando
 * arrivano dei valori.
 */
vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { IntlMessageFormat } = await import('intl-messageformat');
  const cartella = join(process.cwd(), 'messages/it');
  const cataloghi: Record<string, unknown> = {};
  for (const file of readdirSync(cartella)) {
    if (!file.endsWith('.json')) continue;
    cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
  }
  const foglia = (ns: string | undefined, chiave: string): string | undefined => {
    const base = ns ? cataloghi[ns] : cataloghi;
    if (!base || typeof base !== 'object') return undefined;
    const piatta = (base as Record<string, unknown>)[chiave];
    if (typeof piatta === 'string') return piatta;
    let corrente: unknown = base;
    for (const pezzo of chiave.split('.')) {
      if (!corrente || typeof corrente !== 'object') return undefined;
      corrente = (corrente as Record<string, unknown>)[pezzo];
    }
    return typeof corrente === 'string' ? corrente : undefined;
  };
  const resolve = (ns: string | undefined, key: string): string =>
    foglia(ns, key) ?? (ns ? `${ns}.${key}` : key);
  const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
    try {
      return String(new IntlMessageFormat(messaggio, 'it').format(valori));
    } catch {
      return messaggio;
    }
  };
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) =>
      valori === undefined ? resolve(ns, key) : formatta(resolve(ns, key), valori);
    return Object.assign(t, {
      rich: (key: string) => resolve(ns, key),
      markup: (key: string) => resolve(ns, key),
      raw: (key: string) => resolve(ns, key),
      has: () => true,
    });
  };
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  };
});

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
 *    la fattura non si emette, e la coda risponde 400 `PAGAMENTO_NON_SALDATO`.
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
 * tre righe non si tocca mai.
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

/** Le opzioni del finto server. È un OGGETTO vivo: un caso può cambiarle fra due click. */
interface OpzioniStub {
  movimenti?: unknown[];
  anteprimaPerId?: Record<string, unknown>;
  /** I pagamenti che la coda dichiara GIÀ in coda (voce attiva) invece di accodarli. */
  giaPerId?: Record<string, boolean>;
  /** Sostituisce la risposta della coda (un 503, un 400, un 200 illeggibile…). */
  codaRisposta?: RispostaPost;
  /** La POST alla coda non arriva mai: `fetch` lancia. */
  codaRete?: boolean;
  /** Quanto ci mette la POST alla coda: serve a guardarla MENTRE è in volo. */
  codaRitardoMs?: number;
  /** Quanto ci mette UNA anteprima: serve a interrompere il pre-volo A METÀ. */
  anteprimaRitardoMs?: number;
}

/**
 * Il finto server. La coda risponde come la route vera: `{gruppo_id, accodate,
 * gia_in_coda}`, con le voci già attive fuori dal conteggio delle accodate.
 */
function stubFetch(opts: OpzioniStub = {}) {
  const movs = () => opts.movimenti ?? [daFatturare(1), daFatturare(2), daFatturare(3), gia, daAbbinare];
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
    if (u.includes('/api/pagamenti/fattura/coda') && init?.method === 'POST') {
      if (opts.codaRitardoMs) {
        await new Promise<void>((r) => { setTimeout(r, opts.codaRitardoMs); });
      }
      if (opts.codaRete) throw new TypeError('Failed to fetch');
      if (opts.codaRisposta) {
        const r = opts.codaRisposta;
        return { ok: r.stato >= 200 && r.stato < 300, status: r.stato, json: async () => r.corpo };
      }
      const voci = (JSON.parse(init.body ?? '{}') as { voci?: { pagamento_id: string }[] }).voci ?? [];
      const giaInCoda = voci.filter((v) => opts.giaPerId?.[v.pagamento_id]).map((v) => v.pagamento_id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ gruppo_id: 'gruppo-1', accodate: voci.length - giaInCoda.length, gia_in_coda: giaInCoda }),
      };
    }
    if (u.includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: movs(), fatturazione_disponibile: true, conteggi: CONTEGGI }) };
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

type Stub = ReturnType<typeof stubFetch>;

const post = (f: Stub) =>
  f.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
const postCoda = (f: Stub) => post(f).filter(([u]) => String(u).includes('/api/pagamenti/fattura/coda'));
const anteprime = (f: Stub) => f.mock.calls.filter(([u]) => String(u).includes('/api/pagamenti/fattura/anteprima'));

interface VoceInviata {
  pagamento_id: string;
  causale?: unknown;
  intestatario?: unknown;
  conferma_proposta?: unknown;
}
/** Il corpo della i-esima POST alla coda. */
const corpoCoda = (f: Stub, i = 0) =>
  JSON.parse(String((postCoda(f)[i]![1] as { body: string }).body)) as { voci: VoceInviata[]; urgente?: boolean };

/**
 * Seleziona TUTTE le righe e arriva alla conferma: serve ai casi che vogliono
 * più righe di quante se ne spuntino a mano.
 */
async function finoAllaConfermaMolte() {
  render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
  await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);
  fireEvent.click(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ }));
  await avanza(0);
  fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
  await finoA(() => screen.queryByText(/fatture pronte/) !== null, 400);
}

/** Diciotto righe: più del vecchio blocco da quindici, per vedere che partono INSIEME. */
const DICIOTTO = 18;

/** Seleziona le righe indicate e arriva fino al pannello di conferma. */
async function finoAllaConferma(quali = ['m1', 'm2', 'm3']) {
  render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
  await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);
  for (const id of quali) {
    const n = id.replace('m', '');
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`\\(0${n}/10/2026\\)`) }));
  }
  fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
  await finoA(() => screen.queryByText(/fatture pronte|fattura pronta|Nessuna delle righe/) !== null);
}

const bottoneMetti = () => screen.getByRole('button', { name: /^Metti in coda \(\d+\)$/ });

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.setAttribute('lang', 'it');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
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
    // l'accodamento la respinge: `assertPagamentoInScope`. Se avesse la casella,
    // «Seleziona tutte le da fatturare» la conterebbe e le darebbe uno slot del
    // tetto, per mandarla poi contro un rifiuto.
    vi.stubGlobal('fetch', stubFetch({ movimenti: [altraSedeScartata] }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico di un altro plesso/) !== null);

    expect(screen.queryAllByRole('checkbox', { name: /Seleziona il bonifico/ })).toHaveLength(0);
    expect(screen.queryByText(/Seleziona tutte le da fatturare/)).toBeNull();
  });

  it('un pagamento NON saldato col documento scartato non ha casella', async () => {
    // Su un pagamento parziale la fattura non si emette, e l'anteprima — che non ha
    // nessuna guardia sul saldo — lo dichiarerebbe «pronto»: il rifiuto arriverebbe
    // solo alla POST della coda (400 `PAGAMENTO_NON_SALDATO`), per tutto il lotto.
    vi.stubGlobal('fetch', stubFetch({ movimenti: [nonSaldataScartata] }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico non saldato/) !== null);

    expect(screen.queryAllByRole('checkbox', { name: /Seleziona il bonifico/ })).toHaveLength(0);
  });
});

describe('il TETTO si applica alla SELEZIONE, non al momento dell’accodamento', () => {
  // ⚠️ Il tetto si IMPORTA. Dal 2026-09-23 vale 500 e non più 50: non è più «quante ne
  // concede Aruba in un'ora» (quello è il ritmo del lavoratore) ma «quante se ne mettono
  // in coda con un gesto», cioè quante la POST della coda accetta.
  it('la spunta OLTRE IL TETTO è rifiutata: la selezione si ferma lì', async () => {
    // Troncare in silenzio al momento dell'accodamento significherebbe non mettere in
    // coda fatture che l'operatore crede partite. Qui il rifiuto è visibile: la casella
    // resta vuota e il conteggio in fondo alla barra non sale.
    //
    // «Seleziona tutte» porta la selezione AL tetto in un click solo: spuntarne
    // cinquecento a una a una renderebbe questo file lento senza misurare niente di più.
    vi.stubGlobal('fetch', stubFetch({ movimenti: molte(TETTO_LOTTO + 2) }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico lotto 0/) !== null);

    const caselle = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ });
    expect(caselle).toHaveLength(TETTO_LOTTO + 2);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ }));
    await avanza(0);
    fireEvent.click(caselle[TETTO_LOTTO]);
    await avanza(0);

    const dopo = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ }) as HTMLInputElement[];
    expect(dopo.filter((c) => c.checked)).toHaveLength(TETTO_LOTTO);
    expect(dopo[TETTO_LOTTO].checked).toBe(false);
    expect(screen.getByText(`${TETTO_LOTTO} bonifici selezionati`)).toBeInTheDocument();

    // Controprova: il rifiuto è il TETTO, non una casella rotta. Liberato un posto, la
    // stessa casella si spunta.
    fireEvent.click(dopo[0]);
    await avanza(0);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })[TETTO_LOTTO]);
    await avanza(0);
    const finale = screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ }) as HTMLInputElement[];
    expect(finale[TETTO_LOTTO].checked).toBe(true);
    expect(finale.filter((c) => c.checked)).toHaveLength(TETTO_LOTTO);
  });

  it('«Seleziona tutte» dichiara IL TETTO nell’etichetta, e ne spunta esattamente quel numero', async () => {
    vi.stubGlobal('fetch', stubFetch({ movimenti: molte(TETTO_LOTTO + 2) }));
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

  it('la barra dichiara il tetto, e che le fatture partono al ritmo di Aruba', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);

    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    // Il ramo `other` è quello che si vede SEMPRE (il tetto è ben oltre uno): la
    // stringa è in permanenza sotto gli occhi di chi lavora.
    expect(screen.getByText(new RegExp(`Al massimo ${TETTO_LOTTO} fatture per volta: entrano in coda`))).toBeInTheDocument();
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

  it('mentre la POST è in volo dice «Metto in coda le fatture…», ed è ancora LO STESSO NODO', async () => {
    const f = stubFetch({ codaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();
    const prima = screen.getByTestId('lotto-avanzamento');

    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    expect(screen.getByTestId('lotto-avanzamento').textContent).toBe('Metto in coda le fatture…');
    expect(screen.getByTestId('lotto-avanzamento'), 'la live region è stata rimontata').toBe(prima);

    // A cose fatte si svuota: a raccontare è il riepilogo, su cui va il fuoco.
    await avanza(1_000);
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    expect(screen.getByTestId('lotto-avanzamento')).toBe(prima);
    expect(prima.textContent).toBe('');
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
    await finoAllaConferma();

    expect(screen.getByText('2 fatture pronte')).toBeInTheDocument();
    expect(screen.getByText('1 riga da completare')).toBeInTheDocument();
    // e il pre-volo non ha toccato né Aruba né la coda: nessuna POST
    expect(post(f)).toHaveLength(0);
  });

  it('la causale mostrata è quella dell’ANTEPRIMA, non una ricomposta nel browser', async () => {
    vi.stubGlobal('fetch', stubFetch());
    await finoAllaConferma(['m1']);
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

  it('smontato il pannello a pre-volo in corso, nessuna anteprima nuova e nessuna POST', async () => {
    // Il ciclo delle anteprime è una funzione `async` già in volo: senza il cleanup
    // continuerebbe a chiedere anteprime per un pannello che non c'è più.
    const f = stubFetch({ movimenti: molte(8), anteprimaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    const selezionate = molte(8) as unknown as MovimentoUi[];
    const { unmount } = render(
      <LottoFatturePanel userId="u1" selezionate={selezionate} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await avanza(0);
    expect(anteprime(f)).toHaveLength(4);

    unmount();
    await avanza(10_000);
    expect(anteprime(f), 'il secondo blocco di anteprime non deve partire senza pannello').toHaveLength(4);
    expect(post(f)).toHaveLength(0);
  });
});

describe('l’accodamento: UNA POST alla coda, e il lotto non emette niente da sé', () => {
  it('diciotto pronte → UNA sola POST a `/fattura/coda`, con tutte e diciotto nell’ordine, e nessuna a `/fattura/lotto`', async () => {
    // ⚠️ QUESTO CASO ASSERIVA «due blocchi, mai due in volo insieme». Con la coda il
    // browser non pilota più niente: le diciotto partono INSIEME in una richiesta sola,
    // e a dosarle è il lavoratore sul server.
    const f = stubFetch({ movimenti: molte(DICIOTTO) });
    vi.stubGlobal('fetch', f);
    await finoAllaConfermaMolte();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null, 200);
    // Nemmeno un'ora di orologio fa partire una seconda richiesta.
    await avanza(3_600_000);

    expect(postCoda(f)).toHaveLength(1);
    expect(post(f)).toHaveLength(1);
    expect(f.mock.calls.some(([u]) => String(u).includes('/api/pagamenti/fattura/lotto'))).toBe(false);

    const corpo = corpoCoda(f);
    expect(corpo.voci.map((v) => v.pagamento_id)).toEqual(Array.from({ length: DICIOTTO }, (_, k) => `pgx${k}`));
    // Il lotto NON è urgente: in testa alla coda ci va solo il pulsante singolo.
    expect(corpo.urgente ?? false).toBe(false);
  });

  it('ogni voce porta `causale: null` — che toglie la correzione manuale appiccicosa — e niente conferma senza proposta', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);

    for (const voce of corpoCoda(f).voci) {
      expect('causale' in voce).toBe(true);
      expect(voce.causale).toBeNull();
      // Le tre righe erano emettibili per anagrafica: nessun intestatario da imporre,
      // nessuna proposta da far salvare sulla scheda del bambino.
      expect(voce.intestatario).toBeUndefined();
      expect(voce.conferma_proposta).toBeUndefined();
    }
  });

  it('la schermata finale: «N fatture messe in coda. Partono da sole…», e il link alla coda', async () => {
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).getByTestId('lotto-messe-in-coda').textContent).toBe(
      '3 fatture messe in coda. Partono da sole, anche se chiudi la pagina o spegni il PC.',
    );
    const link = within(riepilogo).getByRole('link', { name: 'Vai alla coda fatture' });
    expect(link.getAttribute('href')).toBe('/admin/coda-fatture');
    // Nessuna «già in coda» da segnalare, e nessuna frase dei vecchi blocchi.
    expect(within(riepilogo).queryByTestId('lotto-gia-in-coda')).toBeNull();
    expect(within(riepilogo).queryByText(/emess[ae]|non tentat/)).toBeNull();
    // Il fuoco va sull'intestazione del riepilogo, e l'uscita è «Chiudi».
    expect(document.activeElement).toBe(screen.getByTestId('lotto-riepilogo-titolo'));
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument();
  });

  it('quelle GIÀ in coda si dicono e si elencano, fuori dal conteggio delle nuove', async () => {
    const f = stubFetch({ giaPerId: { pg2: true } });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).getByTestId('lotto-messe-in-coda').textContent).toMatch(/^2 fatture messe in coda\./);
    expect(within(riepilogo).getByTestId('lotto-gia-in-coda').textContent).toBe('1 era già in coda.');
    // …e QUALE: senza la riga, «3 selezionate, 2 messe in coda» si leggerebbe come una
    // fattura persa.
    expect(within(riepilogo).getByText(/102,00 · 02\/10\/2026/)).toBeInTheDocument();
  });

  it('tutte già in coda: non si scrive «0 fatture messe in coda»', async () => {
    const f = stubFetch({ giaPerId: { pg1: true, pg2: true, pg3: true } });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).queryByTestId('lotto-messe-in-coda')).toBeNull();
    expect(within(riepilogo).getByTestId('lotto-gia-in-coda').textContent).toBe('3 erano già in coda.');
  });

  it('un 200 senza esito leggibile NON diventa «0 messe in coda»: si dice che non si sa, e dove guardare', async () => {
    // È la risposta della route quando la RPC ha scritto ma ha risposto in una forma
    // inattesa: le voci sono con ogni probabilità in coda.
    const f = stubFetch({ codaRisposta: { stato: 200, corpo: { gruppo_id: '', accodate: 0, gia_in_coda: [] } } });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    const riepilogo = screen.getByTestId('lotto-riepilogo');
    expect(within(riepilogo).queryByTestId('lotto-messe-in-coda')).toBeNull();
    expect(within(riepilogo).getByText(/la risposta non dice quante fatture sono entrate/)).toBeInTheDocument();
    expect(within(riepilogo).getByRole('link', { name: 'Vai alla coda fatture' })).toBeInTheDocument();
  });

  it('niente avviso alla chiusura della scheda: a POST partita, la coda lavora anche a PC spento', async () => {
    // Il `beforeunload` esisteva perché chiudere la scheda a lotto in corso voleva dire
    // non sapere più quali fatture fossero partite. Con la coda è il contrario: chiudere
    // la scheda è previsto, e un avviso lo farebbe sembrare pericoloso.
    const aggiunti = vi.spyOn(window, 'addEventListener');
    const f = stubFetch({ codaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    await avanza(1_000);
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    expect(aggiunti.mock.calls.filter(([tipo]) => tipo === 'beforeunload')).toHaveLength(0);
  });

  it('durante la POST il primario resta LO STESSO comando, e un secondo click non spara una seconda POST', async () => {
    const f = stubFetch({ codaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    const primario = bottoneMetti();
    fireEvent.click(primario);
    await finoA(() => postCoda(f).length === 1);
    // Non un nodo nuovo e non un bottone disabilitato: il fuoco resta dov'è.
    expect(bottoneMetti()).toBe(primario);
    expect((primario as HTMLButtonElement).disabled).toBe(false);
    expect(primario.getAttribute('aria-busy')).toBe('true');

    fireEvent.click(primario);
    await avanza(1_000);
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    expect(postCoda(f)).toHaveLength(1);
  });

  it('a POST in volo le caselle sono BLOCCATE; a cose fatte tornano libere', async () => {
    // Le caselle vivono nel pannello PADRE, e il lotto è montato su
    // `selezionati.size > 0`: togliere le spunte mentre la POST è in volo smonterebbe
    // il pannello che deve dire com'è andata.
    const f = stubFetch({ codaRitardoMs: 1_000 });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) {
      expect(c).toBeDisabled();
    }

    await avanza(1_000);
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) {
      expect(c).not.toBeDisabled();
    }
  });

  it('a lotto accodato il padre rilegge la lista: `onDone` una volta, e solo sul successo', async () => {
    const onDone = vi.fn();
    const onLavoro = vi.fn();
    const f = stubFetch({ movimenti: [daFatturare(1)] });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={onDone} onLavoro={onLavoro} />);

    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta/) !== null);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    expect(onDone).toHaveBeenCalledTimes(1);
    // …e il lavoro in volo è finito: il padre può riaprire le caselle.
    expect(onLavoro).toHaveBeenLastCalledWith(false);
  });

  it('nei log del lotto entrano solo conteggi: mai una causale, mai un nome', async () => {
    const f = stubFetch({ giaPerId: { pg2: true } });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    const righe = logSpy.mock.calls.map(([e]) => JSON.stringify(e));
    // Il SUCCESSO si logga (AGENTS.md, regola 5), coi soli numeri.
    expect(righe.some((r) => r.includes('lotto-fatture-accodate: accodate=2 gia_in_coda=1'))).toBe(true);
    for (const r of righe) {
      expect(r).not.toContain('Retta ottobre');
      expect(r).not.toContain('Mario Rossi');
      expect(r).not.toContain('Bonifico retta');
    }
  });
});

describe('quando la coda dice di no, lo si legge — e si ritenta dalla conferma', () => {
  it('503 `CODA_FATTURE_NON_DISPONIBILE`: la frase tradotta, nessun riepilogo, e «Metti in coda» si ripreme', async () => {
    // È la produzione fra il deploy del codice e l'applicazione della migrazione, e il
    // DB E2E della CI: la tabella della coda non c'è. Non è un guasto dell'utente, e non
    // si finge un successo.
    const opzioni: OpzioniStub = {
      codaRisposta: {
        stato: 503,
        corpo: { error: 'La coda delle fatture non è ancora disponibile.', codice: 'CODA_FATTURE_NON_DISPONIBILE' },
      },
    };
    const f = stubFetch(opzioni);
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-errore-coda') !== null);

    const alert = screen.getByTestId('lotto-errore-coda');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(sharedIt.erroreCodaFattureNonDisponibile);
    expect(screen.queryByTestId('lotto-riepilogo')).toBeNull();
    // La lista misurata resta sotto gli occhi, e il comando è ancora lì.
    expect(screen.getByText('3 fatture pronte')).toBeInTheDocument();

    // La migrazione arriva: lo stesso gesto, adesso, accoda.
    opzioni.codaRisposta = undefined;
    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);
    expect(postCoda(f)).toHaveLength(2);
    expect(screen.getByTestId('lotto-messe-in-coda').textContent).toMatch(/^3 fatture messe in coda\./);
    expect(screen.queryByTestId('lotto-errore-coda')).toBeNull();
  });

  it('un rifiuto NON fa rileggere la lista né libera le caselle: niente è cambiato, e si è ancora in conferma', async () => {
    // `onDone` dice al padre «il mondo è cambiato»: chiamarlo su un rifiuto farebbe
    // rileggere lista e conteggi per niente, e — peggio — suggerirebbe a chi guarda che
    // qualcosa sia partito.
    const onDone = vi.fn();
    const onLavoro = vi.fn();
    const f = stubFetch({
      movimenti: [daFatturare(1)],
      codaRisposta: { stato: 503, corpo: { codice: 'CODA_FATTURE_NON_DISPONIBILE' } },
    });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={onDone} onLavoro={onLavoro} />);
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta/) !== null);

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-errore-coda') !== null);

    expect(postCoda(f)).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();
    // In conferma la selezione resta congelata: l'ultimo segnale al padre è «in volo».
    expect(onLavoro).toHaveBeenLastCalledWith(true);
  });

  it('400 `PAGAMENTO_NON_SALDATO`: la frase del catalogo, non la prosa del server', async () => {
    const f = stubFetch({
      codaRisposta: {
        stato: 400,
        corpo: { error: 'prosa del server che non deve arrivare a schermo', codice: 'PAGAMENTO_NON_SALDATO', data: { pagamento_ids: ['pg2'] } },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-errore-coda') !== null);
    expect(screen.getByTestId('lotto-errore-coda').textContent).toBe(sharedIt.errorePagamentoNonSaldato);
  });

  it('la POST non arriva: dice che le fatture POTREBBERO non essere entrate, che ripremere è sicuro, e lo logga', async () => {
    const f = stubFetch({ codaRete: true });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-errore-coda') !== null);

    const testo = screen.getByTestId('lotto-errore-coda').textContent ?? '';
    expect(testo).toMatch(/potrebbero non essere entrate/);
    expect(testo).toMatch(/non si duplicano/);
    expect(screen.queryByTestId('lotto-riepilogo')).toBeNull();
    // Un `catch` che non logga è un bug (AGENTS.md, regola 6).
    expect(logSpy.mock.calls.some(([e]) => String((e as { messaggio?: string }).messaggio).startsWith('lotto-fatture-accodamento-fallito'))).toBe(true);
  });
});

describe('la selezione è CONGELATA dal pre-volo fino alla fine', () => {
  it('in fase di conferma le caselle sono BLOCCATE: la lista misurata non può cambiare sotto', async () => {
    // Il pre-volo MISURA una lista e il pannello di conferma la mostra riga per
    // riga: da quel momento «ciò che si vede» e «ciò che partirà» sono la stessa
    // cosa, e restano tali solo se la selezione non si può più toccare.
    vi.stubGlobal('fetch', stubFetch());
    await finoAllaConferma();
    expect(screen.getByText('3 fatture pronte')).toBeInTheDocument();

    for (const c of screen.getAllByRole('checkbox', { name: /Seleziona il bonifico/ })) {
      expect(c).toBeDisabled();
    }
    expect(screen.getByRole('checkbox', { name: /Seleziona tutte le da fatturare/ })).toBeDisabled();
    // L'uscita c'è, ed è dichiarata: si annulla tutto e si ricomincia.
    expect(screen.getByRole('button', { name: 'Annulla selezione' })).toBeInTheDocument();
  });

  it('ciò che va in coda è ciò che il piè di pagina dichiara, anche provando a cambiare idea dopo il controllo', async () => {
    // IL DIFETTO, prima di questa correzione: in `conferma` la terza casella era
    // ancora cliccabile e toglierla NON toglieva la riga dal lotto — che parte da
    // `pronte`, congelato al pre-volo. Tre documenti fiscali per due righe
    // selezionate, e nessuna schermata che dichiarasse la divergenza.
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    // ⚠️ `HTMLElement.click()` e non `fireEvent.click`: il primo È il gesto vero —
    // su un controllo di modulo DISABILITATO non fa niente, e jsdom lo rispetta.
    await act(async () => { screen.getByRole('checkbox', { name: /\(03\/10\/2026\)/ }).click(); });

    expect(screen.getByText('3 bonifici selezionati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Metti in coda (3)' })).toBeInTheDocument();

    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    // ESATTAMENTE le tre misurate al pre-volo, nell'ordine, e nessun'altra.
    expect(corpoCoda(f).voci.map((v) => v.pagamento_id)).toEqual(['pg1', 'pg2', 'pg3']);
  });
});

describe('il piè di pagina dice ciò che serve ALLA FASE in cui si trova', () => {
  it('a lotto ACCODATO non conta più i selezionati e non ripete il tetto', async () => {
    vi.stubGlobal('fetch', stubFetch());
    await finoAllaConferma(['m1']);

    // …e prima di premere il conteggio c'è davvero: senza questa riga il test
    // sarebbe verde anche su un piè di pagina sparito del tutto.
    expect(screen.getByText('1 bonifico selezionato')).toBeInTheDocument();

    fireEvent.click(bottoneMetti());
    await finoA(() => screen.queryByTestId('lotto-riepilogo') !== null);

    expect(screen.queryByText(/bonifico selezionato|bonifici selezionati/)).toBeNull();
    expect(screen.queryByText(/Al massimo \d+ fatture per volta/)).toBeNull();
    // Il comando per uscire, invece, resta.
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument();
  });

  it('il tetto si dichiara solo dove si può ancora scegliere', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await finoA(() => screen.queryByText(/Bonifico retta 1/) !== null);
    fireEvent.click(screen.getByRole('checkbox', { name: /\(01\/10\/2026\)/ }));
    await avanza(0);
    expect(screen.getByText(new RegExp(`Al massimo ${TETTO_LOTTO} fatture per volta`))).toBeInTheDocument();

    // In `conferma` la selezione è congelata: il tetto non è più una regola che
    // riguarda un gesto possibile.
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    expect(screen.queryByText(/Al massimo \d+ fatture per volta/)).toBeNull();
  });
});

describe('«3 selezionati» accanto a «Metti in coda (2)» va SPIEGATO, non dedotto', () => {
  it('quando le pronte sono meno dei selezionati, una frase lega i due numeri', async () => {
    const f = stubFetch({
      anteprimaPerId: {
        pg3: {
          causale: 'Retta ottobre pg3', origine: 'modello', lunghezza: 20, limite: 100, eccede: false,
          intestatario: { alunno: null, quote: [{ adult_id: null, label: 'unica', importo: 100, nome: '', fatturabile: false, errori: { codice_fiscale: 'mancante' } }], ripartito: false, candidati: [], proposta: null, ordinante: null },
        },
      },
    });
    vi.stubGlobal('fetch', f);
    await finoAllaConferma();

    expect(screen.getByText('3 bonifici selezionati')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Metti in coda (2)' })).toBeInTheDocument();
    expect(screen.getByText(/Si emettono solo le righe pronte: 1 resta da completare e non parte/))
      .toBeInTheDocument();

    // …e in coda vanno le DUE pronte, non la terza.
    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    expect(corpoCoda(f).voci.map((v) => v.pagamento_id)).toEqual(['pg1', 'pg2']);
  });

  it('quando i due numeri COINCIDONO la frase non c’è: non c’è niente da spiegare', async () => {
    vi.stubGlobal('fetch', stubFetch());
    await finoAllaConferma();
    expect(screen.getByRole('button', { name: 'Metti in coda (3)' })).toBeInTheDocument();
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

  const monta = (anteprima?: unknown) => {
    const f = stubFetch({ movimenti: [daFatturare(1)], ...(anteprima ? { anteprimaPerId: { pg1: anteprima } } : {}) });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    return f;
  };

  it('una riga che prima era «da completare» diventa pronta, e dice CHI e PERCHÉ', async () => {
    monta(CON_PROPOSTA);
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);

    expect(screen.getByText(/Intestate su proposta del bonifico/i)).toBeTruthy();
    // due volte, ed è giusto: «Intestata a: Rossi Maria» e la frase che spiega
    // il perché, «Bonifico di ROSSI MARIA: il nome corrisponde…»
    expect(screen.getAllByText(/Rossi Maria/).length).toBeGreaterThanOrEqual(2);
    // il «perché» è la frase della SINGOLA, non un doppione scritto per il lotto
    expect(screen.queryByText(/manca l’intestatario/i)).toBeNull();
  });

  it('senza la spunta il lotto NON va in coda, e lo dice invece di restare zitto', async () => {
    const f = monta(CON_PROPOSTA);
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);

    fireEvent.click(bottoneMetti());
    // sincrono di proposito: con i timer finti un `findBy` aspetterebbe un orologio
    // che qui nessuno fa girare — e la mancata partenza è immediata, non attesa
    expect(screen.getByRole('alert').textContent).toMatch(/spunta/i);
    await avanza(0);
    expect(post(f)).toHaveLength(0);
    // il pulsante primario NON si è disabilitato: il fuoco resta dov'è
    expect((bottoneMetti() as HTMLButtonElement).disabled).toBe(false);
  });

  it('con la spunta va in coda, e la voce porta l’intestatario proposto CON la conferma', async () => {
    const f = monta(CON_PROPOSTA);
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);

    // ⚠️ IL CORPO ADESSO È QUELLO DELLA CODA (`voci`), non del lotto a blocchi
    // (`pagamenti`). Ciò che questo caso misura NON cambia — l'intestatario proposto
    // deve arrivare nella POST — più una cosa: `conferma_proposta: true` è ciò che
    // autorizza il lavoratore a salvare quel genitore sulla scheda del bambino, cioè
    // ciò che la nota sotto la spunta promette. Senza, la promessa sarebbe falsa.
    const { voci } = corpoCoda(f);
    expect(voci).toHaveLength(1);
    expect(voci[0].intestatario).toEqual({ tipo: 'adult', adult_id: 'a-1' });
    expect(voci[0].conferma_proposta).toBe(true);
    // `causale: null` resta: è ciò che toglie la correzione manuale appiccicosa
    expect(voci[0].causale).toBe(null);
  });

  it('una riga già emettibile per anagrafica non chiede nessuna spunta, e non impone nessun intestatario', async () => {
    const f = monta();     // anteprima di default: quota fatturabile
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);
    // ⚠️ Prima qui si guardava `.intestatario` al PRIMO livello del corpo, che non l'ha
    // mai avuto: il caso era verde su niente. Si guarda la voce.
    const voce = corpoCoda(f).voci[0];
    expect(voce.pagamento_id).toBe('pg1');
    expect(voce.intestatario).toBeUndefined();
    expect(voce.conferma_proposta).toBeUndefined();
  });

  it('un pagamento ripartito resta fuori, e ora dice il motivo VERO', async () => {
    monta({ ...CON_PROPOSTA, intestatario: { ...CON_PROPOSTA.intestatario, ripartito: true } });
    await finoA(() => screen.queryByText(/ripartito/i) !== null);
    // «manca l'intestatario» qui sarebbe falso: gli intestatari sono due, ed è voluto
    expect(screen.getByText(/ripartito fra due genitori/i)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUANDO L'ANAGRAFICA NON DICE NIENTE — il caso in cui la proposta è tutto
//
// `quote: []` significa che la cascata non ha saputo dire a chi intestare
// (`determinaQuoteFatturazione`, passo 5). Misurato in Conciliazione il 2026-09-08:
// è il caso della maggioranza delle righe selezionabili, e per quasi tutte
// l'ordinante del bonifico nomina UN solo genitore coi dati fiscali completi.
// ─────────────────────────────────────────────────────────────────────────────
describe('quote vuote: l’anagrafica tace, il bonifico no', () => {
  const anteprima = (over: Record<string, unknown> = {}) => ({
    causale: 'Retta ottobre',
    origine: 'modello',
    lunghezza: 20, limite: 100, eccede: false,
    intestatario: {
      alunno: null,
      quote: [],                      // ← la cascata non ha saputo dire niente
      ripartito: false,
      candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', relazione: 'madre', fatturabile: true, errori: {} }],
      proposta: { adult_id: 'a-1', motivo: 'bonifico_esatto' },
      ordinante: 'ROSSI MARIA',
      ...over,
    },
  });

  const apri = (dati: unknown) => {
    const f = stubFetch({ movimenti: [daFatturare(1)], anteprimaPerId: { pg1: dati } });
    vi.stubGlobal('fetch', f);
    render(<LottoFatturePanel userId="u1" selezionate={[daFatturare(1) as unknown as MovimentoUi]} onChiudi={() => {}} onDone={() => {}} onLavoro={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Controlla ed emetti/ }));
    return f;
  };

  it('nessuna quota ma pagatore riconosciuto → PRONTA, col nome e col perché', async () => {
    apri(anteprima());
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);

    expect(screen.getByText(/Intestate su proposta del bonifico/i)).toBeTruthy();
    expect(screen.getAllByText(/Rossi Maria/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Manca l[’']intestatario/i)).toBeNull();
  });

  it('la voce in coda porta l’intestatario proposto — il pezzo che il predicato da solo non copre', async () => {
    // ⚠️ QUESTO È IL CASO CHE VALE. Il pannello decideva se spedire l'intestatario
    // con `!quote.every(fatturabile)`: su un elenco VUOTO `every` risponde `true`,
    // quindi la riga sarebbe entrata nel lotto SENZA intestatario — e il rifiuto si
    // sarebbe spostato dal browser al lavoratore, a quota spesa.
    const f = apri(anteprima());
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(bottoneMetti());
    await finoA(() => postCoda(f).length === 1);

    const voce = corpoCoda(f).voci[0];
    expect(voce.intestatario).toEqual({ tipo: 'adult', adult_id: 'a-1' });
    expect(voce.conferma_proposta).toBe(true);
  });

  it('la spunta dichiara che l’intestatario finisce sulla scheda del bambino E che decide la detrazione', async () => {
    // La conferma non autorizza solo un documento: scrive nell'anagrafica di un
    // minore, e quella riga diventa il «CF pagatore» della comunicazione all'Agenzia
    // delle Entrate e l'intestatario dell'attestazione per il 730.
    apri(anteprima());
    await finoA(() => screen.queryByText(/fattura pronta|fatture pronte/) !== null);
    const nota = screen.getByText(/salvati sulla scheda del bambino/i);
    expect(nota.textContent).toMatch(/730|Agenzia delle Entrate/i);

    // …e la casella deve PUNTARE a quella frase: senza `aria-describedby` uno
    // screen reader legge «Confermo gli intestatari proposti» e non sente la riga
    // che dice cosa si sta autorizzando.
    const casella = screen.getByRole('checkbox');
    expect(casella.getAttribute('aria-describedby')).toBe(nota.getAttribute('id'));
    expect(nota.getAttribute('id')).toBeTruthy();
  });

  it('ripartito CON un’anagrafica incompleta: il motivo non dice solo «ripartito»', async () => {
    apri(anteprima({
      ripartito: true,
      quote: [{ adult_id: 'a-1', label: 'Mamma', importo: 50, nome: 'Rossi Maria', fatturabile: true, errori: {} },
              { adult_id: 'a-2', label: 'Papà', importo: 50, nome: '', fatturabile: false, errori: { codice_fiscale: 'mancante' } }],
    }));
    await finoA(() => screen.queryByText(/da completare/i) !== null);
    expect(screen.getByText(/ripartito/i).textContent).toMatch(/anagrafica|dati/i);
  });

  it('pagatore riconosciuto ma con dati incompleti → il motivo VERO, non il generico', async () => {
    apri(anteprima({ candidati: [{ adult_id: 'a-1', nome: 'Rossi Maria', relazione: 'madre', fatturabile: false, errori: { codice_fiscale: 'mancante' } }] }));
    await finoA(() => screen.queryByText(/da completare/i) !== null);

    // «Manca l'intestatario» qui è falso: l'intestatario si sa, gli mancano i dati —
    // e le due frasi mandano l'operatore in due posti diversi.
    expect(screen.getByText(/sa chi ha fatto il bonifico/i)).toBeTruthy();
    expect(screen.queryByText(/Manca l[’']intestatario/i)).toBeNull();
  });

  it('nessuna quota e nessun pagatore riconoscibile → resta «da completare», col generico', async () => {
    apri(anteprima({ candidati: [], proposta: null, ordinante: null }));
    await finoA(() => screen.queryByText(/da completare/i) !== null);
    expect(screen.getByText(/Manca l[’']intestatario/i)).toBeTruthy();
  });
});
