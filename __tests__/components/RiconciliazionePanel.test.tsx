import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

/**
 * `logClient` è spiato, il resto del modulo resta VERO: `nomeErrore` serve davvero
 * al pannello, e un mock intero lo sostituirebbe con `undefined` facendo passare
 * il test per la ragione sbagliata.
 */
const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>();
  return { ...vero, logClient: logSpy };
});

const movimenti = [
  { id: 'm1', data_operazione: '2026-10-05', importo: 150, causale: 'Bonifico retta', controparte: 'Mario Rossi', stato: 'suggerito', pagamento_id: null, suggerimenti: [{ pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'a1', label: 'Mara Bianchi · Retta' }] },
  { id: 'm2', data_operazione: '2026-10-06', importo: 60, causale: 'Mensa', controparte: '', stato: 'da_abbinare', pagamento_id: null, suggerimenti: [] },
  { id: 'm3', data_operazione: '2026-10-07', importo: 200, causale: 'Retta saldata', controparte: '', stato: 'confermato', pagamento_id: 'pg9', suggerimenti: [] },
  { id: 'm4', data_operazione: '2026-10-08', importo: 30, causale: 'Rimborso', controparte: '', stato: 'ignorato', pagamento_id: null, suggerimenti: [] },
];
const aperti = [
  { id: 'pa1', descrizione: 'Retta', importo: 150, importo_pagato: 0, tipo: 'singolo', alunni: { nome: 'Mara', cognome: 'Bianchi' } },
];

/**
 * ⚠️ IL FINTO SERVER CONTA, PERCHÉ QUELLO VERO CONTA SEMPRE.
 *
 * Il server risponde `conteggi` ogni volta che la fatturazione è leggibile: in
 * produzione i numeri sulle pillole CI SONO, e lo stato «senza numeri» è il
 * degrado, non la normalità. Finché questo stub taceva, ogni test di questo file
 * — compresi i sette che premono le pillole di fatturazione, cioè il collaudo
 * principale della schermata — girava sul ramo DEGRADATO. Verdi, e ciechi sullo
 * stato reale.
 *
 * I due numeri sono DIVERSI fra loro a bella posta: una fixture simmetrica non
 * distingue i due bidoni, e uno scambio fra loro resterebbe verde.
 */
const CONTEGGI_STUB = { da_fatturare: 2, fatturate: 1, parziale: false };

function stubFetch(movs = movimenti) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: movs, fatturazione_disponibile: true, conteggi: CONTEGGI_STUB }) };
    }
    if (String(url).includes('/api/pagamenti?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

describe('RiconciliazionePanel — lista a semaforo', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('rende una riga per ogni movimento con lo sfondo pieno per stato', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const html = container.innerHTML;
    // sfondi pieni per i quattro stati (nessuna opacità)
    expect(html).toContain('bg-kidville-green');        // confermato
    expect(html).toContain('bg-kidville-yellow');       // suggerito
    expect(html).toContain('bg-kidville-error-strong');  // da abbinare
    expect(html).toContain('bg-kidville-neutral-soft');  // ignorato
    // marker Alto Contrasto presente
    expect(html).toContain('kv-recon-row--suggerito');
    // niente modificatori di opacità sui fondi a semaforo
    expect(html).not.toContain('bg-kidville-yellow/');
    expect(html).not.toContain('bg-kidville-green/8');
  });

  it('mostra il badge CF quando il primo suggerimento è un aggancio per codice fiscale', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText('CF')).toBeInTheDocument());
  });

  it('cliccando su un filtro rifà il GET con ?stato=', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Suggeriti' }));
    await waitFor(() => {
      const chiamateStato = fetchMock.mock.calls.filter(([u]) => String(u).includes('stato=suggerito'));
      expect(chiamateStato.length).toBeGreaterThan(0);
    });
  });

  it('cliccando una riga apre il popup del movimento', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Bonifico retta/).closest('button')!);
    // il dialog (role=dialog) si apre con l'intestazione del movimento
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Bonifico del/)).toBeInTheDocument();
  });

  it('mantiene l\'import dell\'estratto conto e il riepilogo esito', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    // Il testo dice «estratto conto», non più «CSV»: la porta accetta anche .xls e .xlsx,
    // e un bottone che promette un solo formato fa credere che gli altri non si possano.
    expect(screen.getByText(/Importa estratto conto/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
  });

  it('A1: «Importa estratto conto» è un BOTTONE raggiungibile da tastiera con nome accessibile', () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const btn = screen.getByRole('button', { name: /Importa estratto conto/ });
    expect(btn.tagName).toBe('BUTTON');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    // l'input non è più `hidden` (display:none → fuori dal focus): resta invisibile ma
    // il bottone lo aziona via ref (click da Invio/Spazio sul bottone).
    expect(input.className).not.toContain('hidden');
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(btn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('A5: il CTA «Importa estratto conto» è bianco su verde (AA), non giallo', () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const btn = screen.getByRole('button', { name: /Importa estratto conto/ });
    expect(btn.className).toContain('text-kidville-white');
    expect(btn.className).not.toContain('text-kidville-yellow');
  });

  it('E2: dopo l\'import il toast usa singolare/plurale corretti', async () => {
    const esito = { nuovi: 1, duplicati: 1, scartate: 1, suggeriti: 1, con_cf: 0, da_abbinare: 0 };
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: esito }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      if (String(url).includes('/api/pagamenti?')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data;importo\n2026-01-01;100'], 'estratto.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/1 nuovo movimento/)).toBeInTheDocument());
    const toast = screen.getByText(/1 nuovo movimento/).textContent ?? '';
    expect(toast).toContain('1 già visto');
    expect(toast).toContain('1 riga scartata');
    expect(toast).not.toContain('1 nuovi movimenti');
    expect(toast).not.toContain('1 righe scartate');
  });
});

// Movimento multi-CF (bonifico di famiglia): due CF-match su alunni distinti.
const movMultiCf = [
  {
    id: 'mfam', data_operazione: '2026-10-09', importo: 300, causale: 'BONIFICO FAMIGLIA ROSSI', controparte: 'Mario Rossi',
    stato: 'suggerito', pagamento_id: null,
    suggerimenti: [
      { pagamento_id: 'p1', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'al-1', label: 'Figlio 1 · Retta' },
      { pagamento_id: 'p2', score: 1000, motivi: ['codice fiscale'], cf_match: true, alunno_id: 'al-2', label: 'Figlio 2 · Retta' },
    ],
  },
];

describe('RiconciliazionePanel — Incasso unico (multi-CF)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('«Apri Incasso unico» risolve il pagante comune e invoca onIncassoUnico con rif/tot/alunni', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pagante-comune')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { parent_id: 'genitore-1' } }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movMultiCf }) };
      }
      if (String(url).includes('/api/pagamenti?')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const onIncassoUnico = vi.fn();

    render(<RiconciliazionePanel userId="u1" scuolaId="s1" onIncassoUnico={onIncassoUnico} />);
    await waitFor(() => expect(screen.getByText(/BONIFICO FAMIGLIA ROSSI/)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/BONIFICO FAMIGLIA ROSSI/).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /Apri Incasso unico/ }));

    await waitFor(() => expect(onIncassoUnico).toHaveBeenCalled());
    // il ponte è stato interrogato con gli alunni riconosciuti per CF
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pagamenti/pagante-comune?alunni=al-1,al-2'),
      expect.anything(),
    );
    expect(onIncassoUnico).toHaveBeenCalledWith(expect.objectContaining({
      parent: 'genitore-1',
      tot: 300,
      rif: 'BONIFICO FAMIGLIA ROSSI',
      alunni: ['al-1', 'al-2'],
    }));
  });

  it('ponte non risolutivo (parent_id null) → onIncassoUnico con parent null (degradazione)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/pagante-comune')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { parent_id: null } }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movMultiCf }) };
      }
      if (String(url).includes('/api/pagamenti?')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const onIncassoUnico = vi.fn();

    render(<RiconciliazionePanel userId="u1" scuolaId="s1" onIncassoUnico={onIncassoUnico} />);
    await waitFor(() => expect(screen.getByText(/BONIFICO FAMIGLIA ROSSI/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/BONIFICO FAMIGLIA ROSSI/).closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /Apri Incasso unico/ }));

    await waitFor(() => expect(onIncassoUnico).toHaveBeenCalled());
    expect(onIncassoUnico).toHaveBeenCalledWith(expect.objectContaining({ parent: null, tot: 300 }));
  });

  it('senza onIncassoUnico il bottone non compare (comportamento invariato)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movMultiCf }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO FAMIGLIA ROSSI/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/BONIFICO FAMIGLIA ROSSI/).closest('button')!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apri Incasso unico/ })).toBeNull();
  });
});

/**
 * IL FILE DELLA BANCA PARTE COM'È — e la trappola sta nell'header.
 *
 * `hdr(userId)` imposta `Content-Type: application/json`. Passato insieme a un `FormData`
 * il browser NON scrive più il proprio boundary, e la richiesta arriva al server come un
 * multipart senza delimitatore: illeggibile. Con un mock piatto — uno che risponde 200 a
 * tutto — questo non si vede: lo status è verde e il file non è mai partito.
 *
 * Quindi qui non si guarda l'esito: si guarda ciò che è stato SPEDITO.
 */
describe('RiconciliazionePanel — l’estratto conto si carica com’è', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const postDi = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.find(([u, o]) =>
      String(u).includes('/api/pagamenti/riconciliazione') && (o as { method?: string })?.method === 'POST');

  it('l’input accetta .csv, .xls e .xlsx (non solo il CSV)', () => {
    vi.stubGlobal('fetch', stubFetch());
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const accept = (container.querySelector('input[type="file"]') as HTMLInputElement).accept;
    expect(accept).toContain('.csv');
    expect(accept).toContain('.xls');
    expect(accept).toContain('.xlsx');
    expect(accept).toContain('application/vnd.ms-excel');
  });

  it('il file parte come FormData e NESSUN Content-Type viene impostato a mano', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { nuovi: 1, duplicati: 0, scartate: 0, suggeriti: 0, da_abbinare: 1 } }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['\u00d0\u00cf\u0011\u00e0'], 'Conti.xls', { type: 'application/vnd.ms-excel' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(postDi(fetchMock)).toBeTruthy());
    const [, opzioni] = postDi(fetchMock) as [string, { body: unknown; headers: Record<string, string> }];
    expect(opzioni.body).toBeInstanceOf(FormData);
    // il boundary lo scrive il browser: se lo si sovrascrive, la richiesta è irricevibile
    const chiavi = Object.keys(opzioni.headers ?? {}).map((k) => k.toLowerCase());
    expect(chiavi).not.toContain('content-type');
    expect(chiavi).toContain('x-user-id');
    const fd = opzioni.body as FormData;
    expect(fd.get('file')).toBeInstanceOf(File);
    expect(fd.get('scuola_id')).toBe('s1');
  });

  it('oltre il tetto della piattaforma il file NON parte, e lo si dice', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    // Oltre il tetto risponde Vercel, in `text/plain`: non c'è nessun JSON da leggere.
    const grosso = new File(['x'], 'Enorme.xls', { type: 'application/vnd.ms-excel' });
    Object.defineProperty(grosso, 'size', { value: 5_000_000 });
    fireEvent.change(input, { target: { files: [grosso] } });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/4 MB/);
    expect(postDi(fetchMock)).toBeUndefined();
  });
});

/**
 * ─── LA RIGA VERDE NON DICEVA MAI «FATTURATO» ────────────────────────────────
 *
 * Fino a oggi la riga diventava verde alla conferma e restava identica per
 * sempre: l'emissione scrive su `pagamenti.fattura_stato` e mai sul movimento.
 * Su un registro globale di centinaia di righe verdi indistinguibili, «quali
 * restano da fatturare?» non aveva risposta — e SALTARE una fattura non lo ferma
 * nessuna guardia (fatturare due volte sì).
 *
 * Le fixture qui sotto portano i due campi DERIVATI del contratto nuovo
 * (`pagamento_stato`, `fattura_stato`), valorizzati dal server solo sui
 * confermati della propria sede: la riga suggerita li ha assenti, ed è
 * esattamente il caso che dimostra che il chip non nasce dal nulla.
 */
const movimentiFatt = [
  { id: 'mf1', data_operazione: '2026-10-05', importo: 150, causale: 'Bonifico da fatturare', controparte: '', stato: 'confermato', pagamento_id: 'pg1', suggerimenti: [], pagamento_stato: 'pagato', fattura_stato: 'non_richiesta' },
  { id: 'mf2', data_operazione: '2026-10-06', importo: 200, causale: 'Bonifico gia fatturato', controparte: '', stato: 'confermato', pagamento_id: 'pg2', suggerimenti: [], pagamento_stato: 'pagato', fattura_stato: 'emessa' },
  { id: 'mf3', data_operazione: '2026-10-07', importo: 90, causale: 'Bonifico solo suggerito', controparte: '', stato: 'suggerito', pagamento_id: null, suggerimenti: [], pagamento_stato: null, fattura_stato: null },
  { id: 'mf4', data_operazione: '2026-10-08', importo: 70, causale: 'Bonifico confermato non saldato', controparte: '', stato: 'confermato', pagamento_id: 'pg4', suggerimenti: [], pagamento_stato: 'parziale', fattura_stato: 'non_richiesta' },
];

/** La riga (è un `<button>`) che porta quella causale. */
const rigaDi = (causale: string) =>
  screen.getByText(new RegExp(causale)).closest('button') as HTMLButtonElement;

/**
 * ⚠️ DUE GET ALLA STESSA ROTTA, E CONTARLI INSIEME NON MISURA PIÙ NIENTE.
 *
 * Dal 2026-09-07 il pannello chiede al registro due cose diverse: le RIGHE da
 * mostrare (`?stato=&fattura=`) e i due NUMERI delle pillole (`?conteggi=1`), che
 * sono una richiesta a sé perché non dipende dalla pillola premuta. Le asserzioni
 * «in UNA sola richiesta» parlano delle prime: se contassero anche il conteggio
 * direbbero «due» su un comportamento corretto, e il giorno in cui il pannello
 * tornasse a ricaricare in ciclo non si distinguerebbe più il rumore dal difetto.
 *
 * La forza dell'asserzione non cambia — resta «una sola» — cambia solo che adesso
 * l'insieme misurato è quello che il suo nome ha sempre promesso.
 */
const richiesteDiRighe = (m: ReturnType<typeof vi.fn>) =>
  m.mock.calls.filter(([u, o]) =>
    String(u).includes('/api/pagamenti/riconciliazione')
    && (o as { method?: string })?.method === undefined
    && !String(u).includes('conteggi=1'));

/** Le richieste dei soli NUMERI delle pillole (`?conteggi=1`). */
const richiesteDiConteggi = (m: ReturnType<typeof vi.fn>) =>
  m.mock.calls.filter(([u]) => String(u).includes('conteggi=1'));

describe('RiconciliazionePanel — chip di fatturazione sulla riga', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch(movimentiFatt)); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('confermato + saldato + fattura non richiesta → chip «Da fatturare» giallo su inchiostro', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const chip = rigaDi('Bonifico da fatturare').querySelector('.kv-recon-chip') as HTMLElement;
    expect(chip, 'la riga da fatturare deve portare il chip').toBeTruthy();
    expect(chip.textContent).toContain('Da fatturare');
    expect(chip.className).toContain('bg-kidville-yellow');
    expect(chip.className).toContain('text-kidville-ink');
    expect(chip.className).toContain('kv-recon-chip--da-fatturare');
  });

  it('fattura emessa → chip «Fatturata» su carta bianca (leggibile sul verde della riga)', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico gia fatturato/)).toBeInTheDocument());

    const chip = rigaDi('Bonifico gia fatturato').querySelector('.kv-recon-chip') as HTMLElement;
    expect(chip.textContent).toContain('Fatturata');
    expect(chip.className).toContain('bg-kidville-white');
    expect(chip.className).toContain('text-kidville-green');
  });

  it('riga suggerita → nessun chip (il server non le manda i campi di fatturazione)', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico solo suggerito/)).toBeInTheDocument());
    expect(rigaDi('Bonifico solo suggerito').querySelector('.kv-recon-chip')).toBeNull();
  });

  it('confermato ma NON saldato → nessun chip (una fattura non richiesta lì è rumore)', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico confermato non saldato/)).toBeInTheDocument());
    expect(rigaDi('Bonifico confermato non saldato').querySelector('.kv-recon-chip')).toBeNull();
  });

  it('nessun chip usa opacità o il grigio `muted` (sta sopra un fondo pieno verde)', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const chips = [...container.querySelectorAll('.kv-recon-chip')] as HTMLElement[];
    expect(chips.length).toBe(2); // solo le due righe fatturabili/fatturate
    for (const c of chips) {
      expect(c.className).not.toContain('text-kidville-muted');
      expect(c.className).not.toMatch(/bg-kidville-[a-z-]+\//);
      expect(c.className).not.toMatch(/text-kidville-[a-z-]+\//);
    }
  });
});

describe('RiconciliazionePanel — sottofiltro «Fatturazione»', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const getMovimenti = (m: ReturnType<typeof vi.fn>) => richiesteDiRighe(m);

  it('«Da fatturare» chiede al server i CONFERMATI con ?fattura=da_fatturare, in UNA sola richiesta', async () => {
    const fetchMock = stubFetch(movimentiFatt);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());
    const prima = getMovimenti(fetchMock).length;

    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Da fatturare e scartate' }));

    await waitFor(() => expect(getMovimenti(fetchMock).length).toBe(prima + 1));
    const ultima = String(getMovimenti(fetchMock).at(-1)?.[0]);
    expect(ultima).toContain('stato=confermato');
    expect(ultima).toContain('fattura=da_fatturare');
    // la pill scelta si dichiara premuta (nessun stato solo cromatico)
    expect(within(gruppo).getByRole('button', { name: 'Da fatturare e scartate' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('«Fatturate» compone lo stesso taglio sui confermati', async () => {
    const fetchMock = stubFetch(movimentiFatt);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Fatturate e in attesa' }));

    await waitFor(() => expect(String(getMovimenti(fetchMock).at(-1)?.[0])).toContain('fattura=fatturate'));
    expect(String(getMovimenti(fetchMock).at(-1)?.[0])).toContain('stato=confermato');
  });

  /**
   * ⚠️ IL PANNELLO RICARICAVA IN LOOP, E NESSUN TEST POTEVA VEDERLO.
   *
   * `load` aveva `t` fra le dipendenze (serviva per un messaggio d'errore). `t`
   * non è garantito stabile fra un render e l'altro — sul banco di prova il mock
   * di `useTranslations` ne crea uno nuovo ogni volta — quindi: effetto → fetch →
   * `setLoading(false)` → render → nuovo `t` → nuovo `load` → effetto. Misurato
   * prima della correzione: **1.470 GET in 300 ms di quiete assoluta**.
   *
   * Restava invisibile perché ogni asserzione sulle fetch guardava «ce n'è almeno
   * una», mai «quante». Qui si guarda il numero, in una finestra in cui l'utente
   * non tocca niente: è l'unica forma in cui questo difetto è dicibile.
   */
  it('a riposo il pannello NON richiama il server: nessun ciclo di ricarica', async () => {
    const fetchMock = stubFetch(movimentiFatt);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const subito = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchMock.mock.calls.length).toBe(subito);
  });

  it('scegliere uno stato diverso da «Confermati» AZZERA il sottofiltro (niente ?fattura= appeso)', async () => {
    const fetchMock = stubFetch(movimentiFatt);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Da fatturare e scartate' }));
    await waitFor(() => expect(String(getMovimenti(fetchMock).at(-1)?.[0])).toContain('fattura=da_fatturare'));

    // ⚠️ «Suggeriti» e «da fatturare» non possono valere insieme: il taglio di
    // fatturazione esiste solo sui confermati. Restare appeso darebbe un elenco
    // sempre vuoto, e un filtro che non trova mai niente si legge come un guasto.
    fireEvent.click(screen.getByRole('button', { name: 'Suggeriti' }));
    await waitFor(() => expect(String(getMovimenti(fetchMock).at(-1)?.[0])).toContain('stato=suggerito'));
    expect(String(getMovimenti(fetchMock).at(-1)?.[0])).not.toContain('fattura=');
    expect(within(screen.getByRole('group', { name: 'Filtra per fatturazione' })).getByRole('button', { name: 'Tutte' }))
      .toHaveAttribute('aria-pressed', 'true');
  });
});

/**
 * ─── «NESSUN MOVIMENTO IN QUESTO STATO» ERA UNA BUGIA ────────────────────────
 *
 * Quando la query batch sui pagamenti cade, il server non sa più dire se una riga
 * verde sia fatturata: `fattura_stato` esce `null` PER COSTRUZIONE. Con il
 * sottofiltro «Da fatturare» acceso, l'elenco usciva vuoto e la schermata scriveva
 * «Nessun movimento in questo stato» — cioè **«non c'è niente da fatturare»**, la
 * frase esatta che questa funzione esiste per non far mai dire per sbaglio.
 *
 * Il server adesso lo dichiara (`fatturazione_disponibile: false`, righe NON
 * filtrate); qui si verifica che la schermata lo DICA all'operatore invece di
 * mostrare una lista che sembra filtrata — e che quando il server RIFIUTA
 * (`success: false`) l'utente veda un errore invece del silenzio.
 */
describe('RiconciliazionePanel — quando il filtro di fatturazione non si può applicare', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /** Un finto server che risponde alla GET dei movimenti con un corpo scelto dal test. */
  const fetchCon = (corpo: Record<string, unknown>, ok = true, status = 200) =>
    vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === undefined) {
        return { ok, status, json: async () => corpo };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });

  /** Accende «Da fatturare» e aspetta che la richiesta col sottofiltro sia partita. */
  const accendiDaFatturare = async (fetchMock: ReturnType<typeof vi.fn>) => {
    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Da fatturare e scartate' }));
    await waitFor(() => expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('fattura=da_fatturare')),
    ).toBe(true));
  };

  it('sottofiltro attivo + `fatturazione_disponibile:false` → fascia d’avviso, e MAI «Nessun movimento in questo stato»', async () => {
    // Registro vuoto: è il caso in cui la vecchia frase compariva davvero. Se la
    // schermata continuasse a scriverla, direbbe «non c'è niente da fatturare»
    // proprio mentre il server ha dichiarato di non aver potuto guardare.
    const fetchMock = fetchCon({ success: true, data: [], fatturazione_disponibile: false });
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Filtra per fatturazione' })).toBeInTheDocument());

    await accendiDaFatturare(fetchMock);

    await waitFor(() => expect(
      screen.getByText(/Stato di fatturazione non disponibile/),
    ).toBeInTheDocument());
    expect(screen.getByText(/Stato di fatturazione non disponibile/).closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByText(/Nessun movimento in questo stato/)).toBeNull();
  });

  it('la fascia compare SOLO col sottofiltro acceso: senza, non c’è niente di sospeso da dire', async () => {
    const fetchMock = fetchCon({ success: true, data: movimentiFatt, fatturazione_disponibile: false });
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    expect(screen.queryByText(/Stato di fatturazione non disponibile/)).toBeNull();
  });

  it('`success:false` → il rifiuto del server si legge a schermo e finisce in un logClient con lo status', async () => {
    const fetchMock = fetchCon({ error: 'Filtro non riconosciuto' }, false, 400);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toContain('Filtro non riconosciuto');
    // Un 400 che nessuno logga è un 400 che non è mai successo: lo `stato` è
    // l'unica cosa che distingue un filtro sbagliato da un guasto del server.
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', stato: 400 }));
    // …e l'elenco non finge di essere vuoto.
    expect(screen.queryByText(/Nessun movimento/)).toBeNull();
  });

  it('rifiuto senza prosa → il ripiego dice cosa fare, non «errore»', async () => {
    const fetchMock = fetchCon({ success: false }, false, 400);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/Filtro non valido/);
  });

  it('`troncato:true` → si dice quante righe sono uscite, invece di lasciar credere che siano tutte', async () => {
    const fetchMock = fetchCon({ success: true, data: movimentiFatt, fatturazione_disponibile: true, troncato: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    expect(screen.getByText(/Mostrate le prime 4 righe/)).toBeInTheDocument();
  });

  it('risposta normale: nessuna fascia, nessuna nota (le tre aggiunte non fanno rumore)', async () => {
    const fetchMock = fetchCon({ success: true, data: movimentiFatt, fatturazione_disponibile: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    expect(screen.queryByText(/Stato di fatturazione non disponibile/)).toBeNull();
    expect(screen.queryByText(/Mostrate le prime/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/**
 * ─── DUE FILE DI PILLOLE IDENTICHE, E NESSUNA DICE COSA FILTRA ───────────────
 *
 * Sopra la lista c'erano due gruppi con la STESSA pelle, uno sotto l'altro, e a
 * schermo sembravano una fila sola andata a capo: «TUTTI · DA ABBINARE ·
 * SUGGERITI · CONFERMATI · IGNORATI» e «TUTTE · DA FATTURARE · FATTURATE».
 * I due assi si distinguevano per una lettera — «Tutti» contro «Tutte» — e
 * l'unica cosa che diceva di che asse si trattasse era l'`aria-label`: cioè un
 * testo che un vedente non legge mai.
 *
 * L'occhiello è VISIVO e `aria-hidden`: chi usa un lettore di schermo ha già
 * l'etichetta del gruppo, e sentirsela ripetere sarebbe rumore.
 */
describe('RiconciliazionePanel — i due assi di filtro si chiamano per nome', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('ogni fila di pillole ha il suo occhiello, e non è annunciato due volte', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    for (const [testo, gruppo] of [['Stato', 'Filtra per stato'], ['Fatturazione', 'Filtra per fatturazione']] as const) {
      const occhiello = screen.getByText(testo);
      expect(occhiello).toHaveAttribute('aria-hidden', 'true');
      expect(occhiello.className).toContain('font-barlow');
      // …e il gruppo conserva la sua etichetta accessibile, che è più esplicita
      expect(screen.getByRole('group', { name: gruppo })).toBeInTheDocument();
    }
  });

  it('l’occhiello non entra nel gruppo dei bottoni (non è un filtro)', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    expect(within(gruppo).queryByText('Fatturazione')).toBeNull();
    expect(within(gruppo).getAllByRole('button')).toHaveLength(3);
  });
});

/**
 * ─── IL RITMO DELLA RIGA, E I DUE MODI OPPOSTI IN CUI SI ROMPEVA ─────────────
 *
 * Misurato sulle schermate del giro precedente, sulla STESSA lista:
 *
 *  · su MOBILE le righe SENZA chip lasciavano un corridoio vuoto di ~380px:
 *    «CONFERMATO» all'estrema sinistra, il chevron all'estrema destra, il nulla
 *    in mezzo. Con il chip lo spazio era occupato e il ritmo teneva; senza, la
 *    riga sembrava incompiuta;
 *  · su DESKTOP la colonna di destra era larga QUANTO IL SUO CONTENUTO, quindi
 *    ogni riga rubava al testo una quantità diversa: la causale si troncava a
 *    un punto diverso su ogni riga, e su quella con «IN ATTESA SDI» spariva il
 *    cognome della famiglia — che su un registro di riconciliazione è il dato
 *    con cui si decide.
 *
 * Una struttura sola risolve tutti e due, senza duplicare il markup per
 * larghezza (due copie dello stesso chip sono due posti da cui diverge):
 *   · il chevron è fratello del testo e del gruppo di stato, MAI dentro il
 *     gruppo — su mobile sta sulla riga della cifra, quindi il corridoio non
 *     nasce affatto;
 *   · il gruppo di stato è `basis-full` (riga propria su mobile) e diventa una
 *     colonna di larghezza FISSA su desktop, così la troncatura del testo è la
 *     stessa su tutte le righe;
 *   · la colonna del testo è `min-w-0 flex-1`: si prende tutto ciò che avanza,
 *     e `min-w-0` è ciò che le permette davvero di rimpicciolirsi (senza, un
 *     figlio `truncate` tiene la colonna larga quanto il testo intero).
 */
describe('RiconciliazionePanel — il ritmo della riga', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /** Il gruppo di stato di una riga: è il genitore dell'etichetta di stato. */
  const gruppoStatoDi = (causale: string) =>
    within(rigaDi(causale)).getByText('Confermato').parentElement as HTMLElement;

  it('il chevron sta FUORI dal flusso: un corridoio solo, uguale per tutte le righe', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    // La riga SENZA chip è quella che mostrava il corridoio: confermata ma non
    // saldata, quindi `chipFatturazione` torna `null`.
    const gruppo = gruppoStatoDi('Bonifico confermato non saldato');
    const riga = gruppo.closest('button') as HTMLElement;
    const chevron = riga.querySelector('svg') as SVGElement;
    expect(chevron, 'la riga deve avere il suo chevron').toBeTruthy();
    // Fuori dal gruppo di stato E fuori dal flusso: la fetta che si prende non
    // dipende più da quanto è largo il chip della riga.
    expect(gruppo.contains(chevron)).toBe(false);
    expect(chevron.getAttribute('class')).toContain('absolute');
    expect(riga.className).toContain('pr-9');
  });

  it('il gruppo di stato è una riga propria su mobile e una colonna FISSA su desktop', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    for (const causale of ['Bonifico da fatturare', 'Bonifico confermato non saldato']) {
      const gruppo = gruppoStatoDi(causale);
      // mobile: va a capo da solo, quindi tutte le righe hanno la stessa altezza
      expect(gruppo.className).toContain('basis-full');
      // desktop: larghezza dettata dal layout, non dal contenuto → la troncatura
      // della causale è la stessa su ogni riga. 176px, cioè quanto il gruppo più
      // largo misurato (169px: chip «IN ATTESA SDI» + «CONFERMATO»); i 280 di
      // prima erano 111px di fondo vuoto accanto a una causale troncata.
      expect(gruppo.className).toContain('sm:min-w-44');
      expect(gruppo.className).not.toContain('sm:w-[280px]');
      expect(gruppo.className).toContain('sm:shrink-0');
    }
  });

  it('la colonna del testo si prende ciò che avanza (`min-w-0 flex-1`)', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const colonna = screen.getByText(/Bonifico da fatturare/).closest('span')?.parentElement as HTMLElement;
    expect(colonna.className).toContain('flex-1');
    // senza `min-w-0` un figlio `truncate` impedisce alla colonna di stringersi
    expect(colonna.className).toContain('min-w-0');
  });

  /**
   * Il pulsante «Aggiorna» era `text-kidville-muted` — #7B8582 su bianco, cioè
   * **3,80:1**, sotto AA — ed era alto 30px invece di 44. È un bottone-icona: se
   * non si vede e non si prende, tanto vale non averlo. Fuori dal ritaglio della
   * sonda (che misura la `ul`), quindi nessuna misura l'aveva mai guardato.
   */
  it('«Aggiorna» è un bersaglio da 44px e non usa il grigio `muted` (3,80:1)', async () => {
    vi.stubGlobal('fetch', stubFetch(movimentiFatt));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const aggiorna = screen.getByRole('button', { name: 'Aggiorna' });
    expect(aggiorna.className).toContain('h-11');
    expect(aggiorna.className).toContain('w-11');
    expect(aggiorna.className).not.toContain('text-kidville-muted');
  });
});

/**
 * ─── QUANDO UNA CHIAVE MANCA, LA SEGRETERIA LEGGE IL CODICE SORGENTE ─────────
 *
 * next-intl non esplode su una chiave assente: scrive a schermo il suo NOME.
 * «adminContabilita.reconGruppoStato» sopra un gruppo di filtri è arrivato fin
 * dentro le misure del collaudo, e nessun test se n'era accorto — perché nessun
 * test guardava la FORMA del testo renderizzato.
 *
 * Questa sonda cammina sui nodi di testo del pannello e rifiuta tutto ciò che ha
 * la forma di una chiave di catalogo: una parola in camelCase, un punto, un'altra
 * parola, e nessuno spazio in mezzo. Nessuna frase italiana ha quella forma.
 */
const CHIAVE_GREZZA = /^[a-z]+[A-Za-z0-9]*\.[a-zA-Z][A-Za-z0-9]*$/;

function testiRenderizzati(radice: HTMLElement): string[] {
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

describe('RiconciliazionePanel — nessuna chiave di catalogo a schermo', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('la sonda riconosce una chiave grezza e NON scambia per tale una frase italiana', () => {
    // CONTROPROVA: senza questa, un regex sbagliato direbbe «tutto a posto» sempre.
    expect(CHIAVE_GREZZA.test('adminContabilita.reconGruppoStato')).toBe(true);
    expect(CHIAVE_GREZZA.test('adminContabilita.movdlgFatturaDaEmettere')).toBe(true);
    expect(CHIAVE_GREZZA.test('Da fatturare')).toBe(false);
    expect(CHIAVE_GREZZA.test('Pagamento saldato: la fattura non è ancora stata emessa.')).toBe(false);
    expect(CHIAVE_GREZZA.test('05/10/2026')).toBe(false);
  });

  it('occhielli, filtri e righe parlano italiano, non nomi di chiave', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const grezzi = testiRenderizzati(container).filter((s) => CHIAVE_GREZZA.test(s));
    expect(grezzi, 'chiavi di catalogo finite a schermo').toEqual([]);
    // e i due occhielli dei gruppi ci sono davvero, col loro testo
    expect(screen.getByText('Stato')).toBeInTheDocument();
    expect(screen.getByText('Fatturazione')).toBeInTheDocument();
  });
});

/**
 * ─── LA GEOMETRIA DELLA RIGA, MISURATA E NON A OCCHIO ────────────────────────
 *
 * Su desktop la colonna di stato era fissata a 280px mentre il gruppo più largo
 * dell'intera lista — chip «IN ATTESA SDI» + «CONFERMATO» — ne misura 169
 * (misurato sul server di sviluppo a 1280px). I 111px di differenza erano verde
 * vuoto fra la causale troncata e il chip: una riga tagliata con un quarto di
 * riga libera accanto non si legge come una scelta, si legge come un guasto.
 *
 * E il chevron stava nel flusso, quindi ogni riga gli cedeva una fetta diversa.
 * Adesso ha un corridoio suo, in posizione assoluta: uno solo, uguale per tutte
 * le righe, e il testo non ci finisce sotto perché il bottone gli riserva il
 * padding a destra.
 */
describe('RiconciliazionePanel — la geometria della riga', () => {
  beforeEach(() => { vi.stubGlobal('fetch', stubFetch()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('la colonna di stato è larga quanto il gruppo più largo, non 280px', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const gruppo = container.querySelector('li button span[class*="sm:min-w-"]') as HTMLElement;
    expect(gruppo, 'la colonna di stato deve avere una larghezza dichiarata su desktop').toBeTruthy();
    expect(gruppo.className).toContain('sm:min-w-44');
    expect(container.innerHTML, '280px erano 113px di fondo vuoto sulla riga').not.toContain('sm:w-[280px]');
  });

  it('il chevron ha un corridoio suo: fuori dal flusso, uguale per tutte le righe', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());

    const riga = container.querySelector('li button') as HTMLElement;
    expect(riga.className, 'senza `relative` il chevron assoluto si àncora alla pagina').toContain('relative');
    expect(riga.className, 'il corridoio del chevron va riservato, o il testo ci finisce sotto').toContain('pr-9');
    const chevron = riga.querySelector('svg') as SVGElement;
    expect(chevron.getAttribute('class')).toContain('absolute');
    expect(chevron.getAttribute('class')).toContain('-translate-y-1/2');
  });

  it('«Aggiorna» è un cerchio da 44px che non si può schiacciare', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const aggiorna = await screen.findByRole('button', { name: 'Aggiorna' });
    expect(aggiorna.className).toContain('h-11');
    expect(aggiorna.className).toContain('w-11');
    // senza `shrink-0` il flex del titolo lo stringe a 20px: misurato, 20×44
    expect(aggiorna.className, 'un bottone-icona schiacciato è una capsula, non un cerchio').toContain('shrink-0');
  });
});

/**
 * ─── DUE ERRORI IN FILA, E IL PRIMO RESTAVA APPESO ───────────────────────────
 *
 * `load` ha tre uscite e due stati d'errore: `rifiuto` (il server ha risposto e
 * ha detto di no) ed `erroreRete` (la risposta non è arrivata affatto). Il ramo
 * felice li azzera entrambi; gli altri due ne azzeravano UNO ciascuno — cioè
 * nessuno azzerava quello dell'altro.
 *
 * Conseguenza a schermo: dopo un 400, un errore di rete lasciava la fascia a
 * ripetere il messaggio VECCHIO. La fascia sceglie `error ?? messaggioRifiuto ??
 * «errore di rete»`: con `rifiuto` ancora valorizzato il terzo ramo non si
 * raggiunge mai, e l'operatore legge «Filtro non riconosciuto» mentre il
 * problema è che la rete è caduta. Due diagnosi opposte — cambia il filtro,
 * contro riprova fra un attimo — e quella mostrata è quella sbagliata.
 *
 * ⚠️ E IL VUOTO NON PUÒ PARLARE MENTRE PARLA LA FASCIA. `vuoto` esclude già
 * `messaggioRifiuto` e `avvisoFatturazione` con la regola scritta accanto:
 * «"Nessun movimento" è una AFFERMAZIONE, e si può fare solo quando si sa che è
 * vera». `erroreRete` mancava all'appello, ed è lo stato in cui non si sa MENO
 * di tutti: la risposta non è arrivata. Senza, azzerare `rifiuto` avrebbe
 * scoperto la frase «Nessun movimento: importa un estratto conto per iniziare.»
 * proprio sotto la fascia rossa dell'errore di rete.
 */
describe('RiconciliazionePanel — un errore non lascia in piedi il precedente', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /**
   * Un finto server pilotabile a metà corsa: `modo` decide come risponde la GET
   * dei movimenti al prossimo giro. I pagamenti aperti rispondono sempre bene,
   * così l'unica variabile è quella che si sta misurando.
   */
  const fetchPilotato = (stato: { modo: 'rifiuto' | 'rete' }) =>
    vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === undefined) {
        if (stato.modo === 'rete') throw new TypeError('Failed to fetch');
        return { ok: false, status: 400, json: async () => ({ error: 'Filtro non riconosciuto' }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });

  it('400 e POI caduta di rete: la fascia dice l’errore nuovo, non riscrive il vecchio', async () => {
    const stato: { modo: 'rifiuto' | 'rete' } = { modo: 'rifiuto' };
    vi.stubGlobal('fetch', fetchPilotato(stato));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Filtro non riconosciuto'));

    // Cade la rete. «Aggiorna» rifà lo stesso identico GET.
    stato.modo = 'rete';
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Errore di rete'));
    // La riga che dimostra il difetto: senza `setRifiuto(null)` qui c'era ancora
    // «Filtro non riconosciuto», cioè si continuava a mandare l'operatore a
    // cambiare un filtro mentre il problema era la rete.
    expect(
      screen.getByRole('alert').textContent,
      'il messaggio del 400 precedente non può sopravvivere a un errore di rete',
    ).not.toContain('Filtro non riconosciuto');
  });

  it('durante un errore di rete il vuoto TACE: nessun «Nessun movimento»', async () => {
    // Non serve il 400 prima: è il caso semplice, e vale da solo. La lista è
    // vuota perché la risposta non è arrivata — dire «non c'è niente da
    // riconciliare» sarebbe un'affermazione su dati che non si sono visti.
    vi.stubGlobal('fetch', fetchPilotato({ modo: 'rete' }));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Errore di rete'));

    expect(screen.queryByText(/Nessun movimento/)).toBeNull();
  });

  it('controprova dell’ordine inverso: rete e POI 400, la fascia passa al rifiuto', async () => {
    // ⚠️ Questa prova era VERDE anche prima della correzione, e va detto: la
    // fascia preferisce già `messaggioRifiuto` al ripiego di rete, quindi il
    // testo era giusto pur restando `erroreRete` acceso. Sta qui perché la
    // correzione azzera i due stati in ENTRAMBI i rami, e senza controprova
    // «azzerare anche l'altro» potrebbe rompere l'ordine inverso senza che
    // nessuno se ne accorga.
    const stato: { modo: 'rifiuto' | 'rete' } = { modo: 'rete' };
    vi.stubGlobal('fetch', fetchPilotato(stato));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Errore di rete'));

    stato.modo = 'rifiuto';
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Filtro non riconosciuto'));
    expect(screen.getByRole('alert').textContent).not.toContain('Errore di rete');
  });
});

/**
 * ─── E IL TERZO STATO NON SI AZZERAVA MAI (2026-09-06) ───────────────────────
 *
 * Il describe qui sopra ha rimesso in riga DUE dei tre stati d'errore — `rifiuto`
 * ed `erroreRete` — e ne ha dimostrato l'esclusione reciproca. Il terzo, `error`,
 * è rimasto fuori: lo scrive l'IMPORT dell'estratto conto e non lo azzera nessuno
 * dei rami di `load`. Siccome la fascia sceglie `error ?? messaggioRifiuto ??
 * «errore di rete»`, `error` sta in TESTA alla catena: finché è appeso, gli altri
 * due non si vedono nemmeno se il guasto è cambiato.
 *
 * Misurato dal collaudo frontend: 422 sull'import → fascia «Colonne non
 * riconosciute nel file» → cambio filtro RIUSCITO → la fascia resta → rete giù →
 * la fascia parla ancora del file. Cioè la diagnosi sbagliata due volte di fila,
 * su una schermata la cui unica ragione d'essere è non far saltare una fattura.
 *
 * Le prove sono scritte sui MESSAGGI VISIBILI, non sulla forma dello stato: la
 * correzione unifica i tre stati in uno solo, e un test che guardasse i tre
 * `useState` sarebbe rosso per la rifattorizzazione invece che per il difetto.
 */
describe('RiconciliazionePanel — l’errore dell’import non sopravvive a ciò che viene dopo', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /** Finto server pilotabile: la GET dei movimenti obbedisce a `modo`, la POST rifiuta sempre. */
  const fetchPilotato = (stato: { modo: 'ok' | 'rete' }) =>
    vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ error: 'Colonne non riconosciute nel file' }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        if (stato.modo === 'rete') throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });

  /** Carica un `.csv` qualunque: la POST risponde 422 e la fascia si accende. */
  const importaEFallisci = async (container: HTMLElement) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data;importo\n'], 'Conti.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Colonne non riconosciute'));
  };

  it('import fallito e POI un filtro RIUSCITO: la fascia si spegne, non resta appesa', async () => {
    vi.stubGlobal('fetch', fetchPilotato({ modo: 'ok' }));
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
    await importaEFallisci(container);

    // Il filtro fa il suo GET e VA A BUON FINE: non è rimasto niente da segnalare.
    fireEvent.click(screen.getByRole('button', { name: 'Confermati' }));

    await waitFor(() => expect(
      screen.queryByRole('alert'),
      'un caricamento riuscito azzera la fascia: l’errore dell’import è di due schermate fa',
    ).toBeNull());
  });

  it('import fallito e POI la rete giù: la fascia dice la RETE, non ancora il file', async () => {
    const stato: { modo: 'ok' | 'rete' } = { modo: 'ok' };
    vi.stubGlobal('fetch', fetchPilotato(stato));
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
    await importaEFallisci(container);

    stato.modo = 'rete';
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Errore di rete'));
    expect(
      screen.getByRole('alert').textContent,
      'il 422 dell’import copriva la caduta della rete: due diagnosi opposte, mostrata quella sbagliata',
    ).not.toContain('Colonne non riconosciute');
  });

  it('import fallito e POI un rifiuto del server: si legge il rifiuto, non il file', async () => {
    // La controprova del terzo incrocio: `error` batteva anche `messaggioRifiuto`,
    // che è l'unico dei tre a dire quale filtro correggere.
    const stato = { rifiuta: false };
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ error: 'Colonne non riconosciute nel file' }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return stato.rifiuta
          ? { ok: false, status: 400, json: async () => ({ error: 'Filtro non riconosciuto' }) }
          : { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    }));
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
    await importaEFallisci(container);

    stato.rifiuta = true;
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Filtro non riconosciuto'));
    expect(screen.getByRole('alert').textContent).not.toContain('Colonne non riconosciute');
  });

  it('e all’inverso: un errore dell’import copre il rifiuto precedente (una fascia, l’ultimo guasto)', async () => {
    // Il verso opposto vale come regola, non come effetto collaterale: la fascia è
    // UNA, e dice l'ULTIMO guasto. Senza questa prova, «azzerare anche il terzo»
    // potrebbe diventare «il terzo non si mostra più».
    const stato = { rifiuta: true };
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ error: 'Colonne non riconosciute nel file' }) };
      }
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return stato.rifiuta
          ? { ok: false, status: 400, json: async () => ({ error: 'Filtro non riconosciuto' }) }
          : { ok: true, status: 200, json: async () => ({ success: true, data: movimenti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    }));
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Filtro non riconosciuto'));

    await importaEFallisci(container);
    expect(screen.getByRole('alert').textContent).not.toContain('Filtro non riconosciuto');
  });
});

/**
 * ─── IL VERDETTO «ALTRA SEDE» SULLA LISTA, DOVE STA L'ERRORE ─────────────────
 *
 * Il popup lo diceva già; la LISTA no, e la lista è dove si sbaglia: si scorre,
 * si apre la riga e si preme. MISURATO in produzione applicando la regola sede
 * per sede: 169 righe su 236 per Aversa, 168 per Cesa, 76 per Giugliano portano
 * il verdetto — e per due segreterie su tre non c'è nemmeno un candidato di casa
 * da proporre, cioè la riga non è loro e basta.
 *
 * ⚠️ CHIP, NON UN COLORE NUOVO SULLA RIGA: il fondo della riga è il semaforo dello
 * STATO (da abbinare / suggerito / confermato / ignorato) e non si tocca — «sembra
 * di un'altra sede» è un'altra domanda, su un altro asse. E mai giallo né rosso:
 * qui non c'è un'azione da chiedere a chi guarda.
 */
describe('RiconciliazionePanel — «altra sede» si vede già dalla lista', () => {
  const conVerdetto = [
    { ...movimenti[0], id: 'mx', causale: 'Bonifico di un altro plesso', altra_sede: { nome: 'Kidville Cesa' } },
    movimenti[1],
  ];
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('la riga col verdetto porta il chip, e le altre no', async () => {
    vi.stubGlobal('fetch', stubFetch(conVerdetto));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico di un altro plesso/)).toBeInTheDocument());

    const chip = screen.getAllByText('Altra sede');
    expect(chip, 'una riga sola su due porta il verdetto').toHaveLength(1);
    // sta DENTRO la riga giusta, non da qualche parte nella pagina
    const riga = screen.getByText(/Bonifico di un altro plesso/).closest('button')!;
    expect(within(riga).getByText('Altra sede')).toBeInTheDocument();
    // e porta l'àncora dell'Alto Contrasto: senza, resta carta bianca su riga nera
    expect(chip[0].className).toContain('kv-recon-chip');
  });

  it('senza verdetto nessun chip: la lista di sempre', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
    expect(screen.queryByText('Altra sede')).toBeNull();
  });

  it('il chip non ruba il colore del semaforo né quello dei comandi', async () => {
    vi.stubGlobal('fetch', stubFetch(conVerdetto));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText('Altra sede')).toBeInTheDocument());

    const classi = screen.getByText('Altra sede').className;
    expect(classi).not.toContain('kidville-yellow');
    expect(classi).not.toContain('kidville-error');
    // il fondo della riga resta quello dello stato: il verdetto non ridipinge nulla
    const riga = screen.getByText(/Bonifico di un altro plesso/).closest('button')!;
    expect(riga.className).toContain('kv-recon-row--suggerito');
  });
});

/**
 * ─── I NUMERI SULLE PILLOLE, E LE QUATTRO COSE CHE POSSONO MENTIRE ───────────
 *
 * Le tre pillole dicevano solo il proprio nome: per sapere quante fatture
 * restassero bisognava premerle una per una, e chi non le premeva non lo sapeva.
 * Il numero c'è. Quello che questo blocco sorveglia non è che compaia — è che
 * NON compaia quando sarebbe una bugia:
 *
 *  1. `conteggi: null` (il server non ha potuto contare) → NIENTE. Non uno «0»,
 *     non un «—», non uno spazio riservato: uno zero dove il dato manca è la
 *     stessa bugia di «Nessun movimento in questo stato»;
 *  2. `parziale: true` (finestra del server piena) → «≥ 12», mai «12»;
 *  3. «Tutte» non porta numero: non è un bidone, è l'assenza del filtro;
 *  4. il numero NON dipende dalla pillola premuta. Se il fetch dei conteggi
 *     stesse nell'effetto della lista, premere «Da fatturare» cambierebbe il
 *     numero scritto SOPRA «Da fatturare»: un contatore che si sposta mentre lo
 *     si guarda.
 *
 * E due vincoli sulla forma, che valgono quanto i quattro:
 *  · il nome accessibile della pillola non cambia (il numero è un `<span>`
 *    `aria-hidden` a parte) — altrimenti cinque test esistenti cadrebbero per la
 *    ragione sbagliata, e soprattutto un `getByRole('button', { name })` sarebbe
 *    una promessa rotta a chi automatizza la schermata;
 *  · chi usa uno screen reader il numero lo SENTE: un `aria-describedby` lo dice
 *    in parole. Un numero solo visivo, per lui, semplicemente non esiste.
 */
describe('RiconciliazionePanel — i numeri sulle pillole di «Fatturazione»', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  /** L'esito di un import andato a buon fine: una riga nuova nel registro. */
  const ESITO_IMPORT = { nuovi: 1, duplicati: 0, scartate: 0, suggeriti: 0, con_cf: 0, da_abbinare: 1 };

  /**
   * Finto server: le RIGHE da una parte, i due NUMERI dall'altra — e le due
   * SCRITTURE che cambiano il mondo, perché è dopo quelle che i numeri devono
   * muoversi da soli (`POST` = import dell'estratto conto, `PATCH` = azione sul
   * movimento dal popup).
   */
  const fetchCon = (conteggi: { da_fatturare: number; fatturate: number; parziale: boolean } | null) =>
    vi.fn(async (url: string, opts?: { method?: string }) => {
      const u = String(url);
      if (u.includes('/api/pagamenti/riconciliazione') && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: ESITO_IMPORT }) };
      }
      if (u.includes('/api/pagamenti/riconciliazione/') && opts?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (u.includes('/api/pagamenti/riconciliazione') && opts?.method === undefined) {
        if (u.includes('conteggi=1')) {
          return { ok: true, status: 200, json: async () => ({
            success: true, data: [], fatturazione_disponibile: conteggi !== null, conteggi,
          }) };
        }
        return { ok: true, status: 200, json: async () => ({
          success: true, data: movimentiFatt, fatturazione_disponibile: true,
        }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });

  const pillola = (nome: string) =>
    within(screen.getByRole('group', { name: /Filtra per fatturazione/ })).getByRole('button', { name: nome });

  const montaCon = async (conteggi: Parameters<typeof fetchCon>[0]) => {
    const fetchMock = fetchCon(conteggi);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());
    return fetchMock;
  };

  it('ogni bidone porta il suo numero, e il NOME ACCESSIBILE della pillola non cambia', async () => {
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });

    // ⚠️ Questa riga è metà del test: se il numero entrasse nel nome accessibile,
    // `getByRole('button', { name: 'Da fatturare e scartate' })` non troverebbe
    // più niente — ed è la query con cui cinque test esistenti premono la pillola.
    const daFatturare = pillola('Da fatturare e scartate');
    const fatturate = pillola('Fatturate e in attesa');
    await waitFor(() => expect(within(daFatturare).getByText('12')).toBeInTheDocument());
    expect(within(fatturate).getByText('7')).toBeInTheDocument();
    // il numero è decorazione visiva: chi ascolta lo riceve dalla descrizione
    expect(within(daFatturare).getByText('12')).toHaveAttribute('aria-hidden', 'true');
    // e il conteggio è UNA richiesta sua, che non porta a casa nessuna riga
    expect(richiesteDiConteggi(fetchMock)).toHaveLength(1);
  });

  it('chi non vede il numero lo SENTE: una descrizione accessibile in parole', async () => {
    await montaCon({ da_fatturare: 12, fatturate: 1, parziale: false });

    const daFatturare = pillola('Da fatturare e scartate');
    await waitFor(() => expect(daFatturare.getAttribute('aria-describedby')).toBeTruthy());
    const descrizione = document.getElementById(daFatturare.getAttribute('aria-describedby') as string);
    expect(descrizione?.textContent).toBe('12 movimenti da fatturare');
    // …e il singolare è singolare (il plurale ICU è reso davvero, non stampato)
    const fatturate = pillola('Fatturate e in attesa');
    const desc2 = document.getElementById(fatturate.getAttribute('aria-describedby') as string);
    expect(desc2?.textContent).toBe('1 movimento fatturato');
  });

  it('«Tutte» non porta nessun numero: non è un bidone, è l’assenza del filtro', async () => {
    await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(within(pillola('Da fatturare e scartate')).getByText('12')).toBeInTheDocument());

    const tutte = pillola('Tutte');
    // niente numero, e niente descrizione: non c'è nessun conteggio da spiegare
    expect(tutte.textContent).toBe('Tutte');
    expect(tutte.getAttribute('aria-describedby')).toBeNull();
    // in particolare NON la somma dei due bidoni, che non è il contenuto di «Tutte»
    expect(within(tutte).queryByText('19')).toBeNull();
  });

  it('`conteggi: null` → NIENTE: nessuno zero, nessun «—», nessuno spazio riservato', async () => {
    await montaCon(null);
    // si aspetta che la richiesta dei conteggi sia stata digerita, poi si guarda
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    for (const nome of ['Tutte', 'Da fatturare e scartate', 'Fatturate e in attesa']) {
      const p = pillola(nome);
      // ⚠️ Uno «0» qui sarebbe la stessa bugia di «Nessun movimento in questo
      // stato»: un'affermazione su un dato che nessuno ha letto.
      expect(within(p).queryByText('0')).toBeNull();
      expect(p.textContent).not.toContain('—');
      expect(p.getAttribute('aria-describedby')).toBeNull();
    }
  });

  it('finestra piena → «≥ 12», mai «12»: un minimo si dichiara', async () => {
    await montaCon({ da_fatturare: 12, fatturate: 7, parziale: true });

    const daFatturare = pillola('Da fatturare e scartate');
    await waitFor(() => expect(within(daFatturare).getByText('≥ 12')).toBeInTheDocument());
    // il numero secco non c'è: sarebbe un totale, e questo non lo è
    expect(within(daFatturare).queryByText('12')).toBeNull();
    const descrizione = document.getElementById(daFatturare.getAttribute('aria-describedby') as string);
    expect(descrizione?.textContent).toContain('Almeno 12 movimenti da fatturare');
  });

  it('il conteggio si chiede UNA volta sola: premere le pillole non lo rifà', async () => {
    // ⚠️ IL PUNTO DI TUTTO IL LAVORO. Se il fetch dei conteggi dipendesse dal
    // filtro premuto, il numero scritto SOPRA «Da fatturare» cambierebbe nel
    // momento in cui si preme «Da fatturare»: un contatore che si sposta mentre
    // lo si guarda, e che non risponde più alla domanda «quante ne restano».
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(within(pillola('Da fatturare e scartate')).getByText('12')).toBeInTheDocument());

    const righePrima = richiesteDiRighe(fetchMock).length;
    fireEvent.click(pillola('Da fatturare e scartate'));
    await waitFor(() => expect(richiesteDiRighe(fetchMock).length).toBe(righePrima + 1));
    fireEvent.click(pillola('Fatturate e in attesa'));
    await waitFor(() => expect(richiesteDiRighe(fetchMock).length).toBe(righePrima + 2));

    // due pillole premute, due ricariche dell'elenco… e UN conteggio solo.
    expect(richiesteDiConteggi(fetchMock)).toHaveLength(1);
    // …e il numero è rimasto quello: non si è mosso sotto il dito
    expect(within(pillola('Da fatturare e scartate')).getByText('12')).toBeInTheDocument();
  });

  it('«Aggiorna» rifà anche il conteggio: dopo un’emissione il numero deve scendere', async () => {
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(2));
  });

  /**
   * ⚠️ «AGGIORNA» LO PREME CHI HA GIÀ IL SOSPETTO. QUESTO SCATTA DA SOLO.
   *
   * Il caso qui sopra prova il trigger che l'operatore aziona a mano — cioè
   * quello che serve solo a chi ha già smesso di fidarsi del numero. Il trigger
   * che questa funzione esiste per avere è l'altro: l'operatore emette la
   * fattura nel popup, il popup si chiude, e il numero DEVE essere già sceso.
   * Se non scende, a schermo resta un conteggio che l'operatore ha appena
   * smentito con le proprie mani — la bugia esatta che questo lavoro impedisce.
   *
   * Si esegue un'azione VERA sul popup vero (`Ignora` su una riga suggerita):
   * `onDone` non è un bottone da premere, è ciò che il popup chiama quando
   * l'operazione è andata a buon fine.
   */
  it('dopo un’azione nel popup il conteggio si rifà DA SOLO: è il trigger che nessuno preme', async () => {
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(1));

    fireEvent.click(rigaDi('Bonifico solo suggerito'));
    fireEvent.click(await screen.findByRole('button', { name: /Ignora/ }));

    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(2));
  });

  /**
   * L'import è l'ALTRO momento in cui il mondo cambia: entrano righe nuove nel
   * registro, e quante ne restino da fatturare non è più il numero di prima.
   */
  it('dopo un import riuscito il conteggio si rifà: le righe nuove cambiano quante ne restano', async () => {
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(1));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data;importo\n2026-01-01;100'], 'estratto.csv', { type: 'text/csv' })] } });

    // prima l'esito dell'import (senza, si starebbe misurando un import fallito)
    await waitFor(() => expect(screen.getByText(/1 nuovo movimento/)).toBeInTheDocument());
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(2));
  });

  /**
   * ─── LA RISPOSTA SORPASSATA, CHE ATTERRA PER ULTIMA E RIMETTE IL NUMERO VECCHIO ──
   *
   * Due «Aggiorna» ravvicinati partono in ordine e tornano come capita: la rete
   * non promette niente. Se la PRIMA risposta atterra dopo la seconda, senza una
   * guardia riscrive il numero — e a schermo resta il conteggio di PRIMA
   * dell'emissione, cioè esattamente ciò che il ricalcolo doveva cancellare.
   * Peggio del numero fermo: un numero che si è mosso e poi è tornato indietro.
   *
   * Qui le due risposte si risolvono A MANO e in ordine INVERSO: è l'unico modo
   * di eseguire davvero lo scenario che il commento accanto alla guardia descrive.
   */
  it('una risposta sorpassata NON riscrive il numero: resta quello dell’ultima richiesta', async () => {
    const risposteConteggi: ((conteggi: unknown) => void)[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const u = String(url);
      if (u.includes('conteggi=1')) {
        return new Promise((resolve) => {
          risposteConteggi.push((conteggi) => resolve({
            ok: true, status: 200,
            json: async () => ({ success: true, data: [], fatturazione_disponibile: true, conteggi }),
          }));
        });
      }
      if (u.includes('/api/pagamenti/riconciliazione') && opts?.method === undefined) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: movimentiFatt, fatturazione_disponibile: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());
    await waitFor(() => expect(risposteConteggi).toHaveLength(1));

    // Secondo giro chiesto PRIMA che il primo sia tornato: due richieste in volo.
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }));
    await waitFor(() => expect(risposteConteggi).toHaveLength(2));

    // Torna prima la SECONDA (il mondo dopo l'emissione: 3), e si vede.
    await act(async () => { risposteConteggi[1]({ da_fatturare: 3, fatturate: 7, parziale: false }); });
    await waitFor(() => expect(within(pillola('Da fatturare e scartate')).getByText('3')).toBeInTheDocument());

    // Poi atterra la PRIMA, la fotografia vecchia (12): non deve toccare niente.
    await act(async () => { risposteConteggi[0]({ da_fatturare: 12, fatturate: 7, parziale: false }); });

    expect(within(pillola('Da fatturare e scartate')).getByText('3')).toBeInTheDocument();
    expect(within(pillola('Da fatturare e scartate')).queryByText('12')).toBeNull();
  });

  it('il gruppo dichiara che i due numeri NON sono parti di uno stesso totale — e lo dice DESCRIVENDOSI, non cambiando nome', async () => {
    await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(within(pillola('Da fatturare e scartate')).getByText('12')).toBeInTheDocument());

    // ⚠️ METÀ DEL TEST È QUESTA RIGA. Il nome del gruppo è il suo identificatore:
    // un lettore di schermo lo rilegge a ogni ingresso, e i test lo usano per
    // trovarlo. Farlo diventare una frase di trenta parole appena arrivano i
    // numeri — cioè SEMPRE, in produzione — è due guasti in uno: un'etichetta
    // che muta sotto l'utente, e sette casi di questo file che restavano verdi
    // solo perché il loro finto server non contava.
    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });

    // ⚠️ L'asimmetria esiste già nel server e i due numeri accostati la rendono
    // fuorviante: «Da fatturare» pretende un pagamento saldato, che fuori dalle
    // proprie sedi è `null` — è la lista di lavoro della PROPRIA sede — mentre
    // «Fatturate» guarda i documenti ed è cross-sede. Si dice come DESCRIZIONE,
    // che è la stessa regola già applicata al numero delle singole pillole.
    const descrizione = document.getElementById(gruppo.getAttribute('aria-describedby') as string);
    expect(descrizione?.textContent).toContain('I due numeri non sono parti di uno stesso totale');
    expect(descrizione?.className).toContain('sr-only');
  });

  it('senza numeri il nome NON cambia e la descrizione non c’è: niente da disambiguare', async () => {
    await montaCon(null);

    // Il nome è lo stesso dell'altro caso: è l'identità del gruppo, non un
    // messaggio. A cambiare è solo se ci sia o meno qualcosa da spiegare.
    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    expect(gruppo.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(/I due numeri non sono parti di uno stesso totale/)).toBeNull();
  });

  it('a riposo il conteggio NON si ripete: nessun ciclo di ricarica sul contatore', async () => {
    const fetchMock = await montaCon({ da_fatturare: 12, fatturate: 7, parziale: false });
    await waitFor(() => expect(richiesteDiConteggi(fetchMock)).toHaveLength(1));

    const subito = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchMock.mock.calls.length).toBe(subito);
    expect(richiesteDiConteggi(fetchMock)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IL FILTRO PER SEDE, E IL SUO N.B.
//
// Il registro è cross-sede per progetto: `scuola_id` resta NULL finché il
// movimento non viene confermato. Quindi la sede delle righe che restano da
// lavorare non esiste come colonna e si può solo DEDURRE — e su alcune righe non
// si deduce affatto. Quelle sono i «rossi da controllare», e la schermata deve
// dire che le sta escludendo invece di farle sparire.
// ─────────────────────────────────────────────────────────────────────────────
describe('RiconciliazionePanel — filtro per sede', () => {
  const GIU = 'sc-giu';
  const CESA = 'sc-cesa';
  const conSedi = [
    { ...movimenti[0], id: 's1', sede_dedotta: { scuola_id: GIU, certa: true } },
    { ...movimenti[1], id: 's2', sede_dedotta: { scuola_id: CESA, certa: false } },
    // nessuna sede dedotta: è la riga rossa che il n.b. nomina
    { ...movimenti[1], id: 's3', causale: 'Ignoto', sede_dedotta: null },
    // confermata: la sede è NOTA, sta sulla riga, e non si deduce niente
    { ...movimenti[2], id: 's4', scuola_id: GIU, sede_dedotta: null },
  ];

  function stubConSedi(righe = conSedi, extra: Record<string, unknown> = {}) {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/api/pagamenti/riconciliazione')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            success: true, data: righe, fatturazione_disponibile: true, conteggi: CONTEGGI_STUB,
            sedi: { [GIU]: 'Kidville Giugliano', [CESA]: 'Kidville Cesa' },
            ...extra,
          }),
        };
      }
      if (String(url).includes('/api/pagamenti?')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: aperti }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
  }

  beforeEach(() => { vi.stubGlobal('fetch', stubConSedi()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('offre le sedi DERIVATE DALLE RIGHE, non quelle accessibili all’operatore', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);
    expect(screen.getByRole('button', { name: 'Kidville Giugliano' })).toBeTruthy();
    // Cesa non è la sede dell'operatore, ma nel registro cross-sede la vede: se le
    // opzioni venissero dal contesto sedi, questa pillola non ci sarebbe
    expect(screen.getByRole('button', { name: 'Kidville Cesa' })).toBeTruthy();
  });

  it('l’avvertenza sulla sede dedotta è sempre a schermo, e non è un allarme', async () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    const nota = await screen.findByText(/quella che l’app ha dedotto/i);
    expect(nota).toBeTruthy();
    // mai giallo, mai rosso, mai role="alert": in questa schermata quei toni sono
    // riservati a ciò che chiede un'azione
    expect(nota.getAttribute('role')).toBe(null);
    expect(nota.className).not.toMatch(/warn|error/);
    expect(container).toBeTruthy();
  });

  it('scegliere una sede filtra la lista E DICHIARA quante righe ha escluso', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);

    fireEvent.click(screen.getByRole('button', { name: 'Kidville Giugliano' }));

    // restano le due righe di Giugliano (la dedotta e la confermata)
    expect(screen.queryByText('Ignoto')).toBeNull();
    // ...e la riga che nessuno ha capito non sparisce in silenzio
    const avviso = await screen.findByRole('status');
    expect(avviso.textContent).toMatch(/sede riconosciuta/i);
  });

  it('«Vedile» porta al bidone dei rossi', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Giugliano' }));
    fireEvent.click(await screen.findByRole('button', { name: /Vedile/i }));

    expect(await screen.findByText('Ignoto')).toBeTruthy();
    expect(screen.queryByText(/Bonifico retta/)).toBeNull();
  });

  it('con la finestra troncata il numero delle escluse è un MINIMO', async () => {
    vi.stubGlobal('fetch', stubConSedi(conSedi, { troncato: true }));
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);
    fireEvent.click(screen.getByRole('button', { name: 'Kidville Giugliano' }));
    const avvisi = await screen.findAllByRole('status');
    expect(avvisi.some((a) => a.textContent?.includes('≥'))).toBe(true);
  });

  it('il filtro sede NON fa ripartire nessuna richiesta: vive nel browser', async () => {
    const f = stubConSedi();
    vi.stubGlobal('fetch', f);
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);
    const prima = f.mock.calls.filter((c) => String(c[0]).includes('/riconciliazione')).length;

    fireEvent.click(screen.getByRole('button', { name: 'Kidville Cesa' }));
    await screen.findByText(/Mensa/);

    expect(f.mock.calls.filter((c) => String(c[0]).includes('/riconciliazione')).length).toBe(prima);
  });

  it('«mostrate le prime N» conta le righe A SCHERMO, non quelle scaricate', async () => {
    // Prima contava `movimenti`: con un filtro che vive nel browser i due numeri
    // divergono, e a pochi centimetri di distanza si leggono come un errore del
    // programma.
    vi.stubGlobal('fetch', stubConSedi(conSedi, { troncato: true }));
    render(<RiconciliazionePanel userId="u1" scuolaId={GIU} />);
    await screen.findByText(/Bonifico retta/);

    fireEvent.click(screen.getByRole('button', { name: 'Kidville Cesa' }));
    await screen.findByText(/Mensa/);
    const avvisi = await screen.findAllByRole('status');
    const troncamento = avvisi.map((a) => a.textContent ?? '').join(' | ');
    // quattro righe scaricate, una sola di Cesa a schermo: il «4» non deve
    // comparire da nessuna parte, o sarebbe il numero sbagliato accanto a una
    // lista di uno
    expect(troncamento).not.toMatch(/\b4\b/);
  });
});
