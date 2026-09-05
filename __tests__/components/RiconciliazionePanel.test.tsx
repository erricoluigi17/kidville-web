import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';

vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

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
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Da fatturare' }));

    await waitFor(() => expect(getMovimenti(fetchMock).length).toBe(prima + 1));
    const ultima = String(getMovimenti(fetchMock).at(-1)?.[0]);
    expect(ultima).toContain('stato=confermato');
    expect(ultima).toContain('fattura=da_fatturare');
    // la pill scelta si dichiara premuta (nessun stato solo cromatico)
    expect(within(gruppo).getByRole('button', { name: 'Da fatturare' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('«Fatturate» compone lo stesso taglio sui confermati', async () => {
    const fetchMock = stubFetch(movimentiFatt);
    vi.stubGlobal('fetch', fetchMock);
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/Bonifico da fatturare/)).toBeInTheDocument());

    const gruppo = screen.getByRole('group', { name: 'Filtra per fatturazione' });
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Fatturate' }));

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
    fireEvent.click(within(gruppo).getByRole('button', { name: 'Da fatturare' }));
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
