import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

function stubFetch(movs = movimenti) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/api/pagamenti/riconciliazione')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: movs }) };
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

  const getMovimenti = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter(([u, o]) =>
      String(u).includes('/api/pagamenti/riconciliazione') && (o as { method?: string })?.method === undefined);

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
