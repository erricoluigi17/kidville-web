import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('mantiene l\'import CSV e il riepilogo esito', async () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    expect(screen.getByText(/Importa CSV estratto conto/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Bonifico retta/)).toBeInTheDocument());
  });

  it('A1: «Importa CSV» è un BOTTONE raggiungibile da tastiera con nome accessibile', () => {
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const btn = screen.getByRole('button', { name: /Importa CSV estratto conto/ });
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

  it('A5: il CTA «Importa CSV» è bianco su verde (AA), non giallo', () => {
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    const btn = screen.getByRole('button', { name: /Importa CSV estratto conto/ });
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
