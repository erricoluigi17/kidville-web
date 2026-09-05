import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RiconciliazionePanel } from '@/components/features/admin/pagamenti/RiconciliazionePanel';

/**
 * IL CHIP DELLA FATTURA SULLA RIGA DEL MOVIMENTO.
 *
 * Tre stati che si somigliano solo a parole: «Fattura FPR 1947/26» (il documento c'è, e si
 * dice quale), «Scartata, da riemettere» (c'è stato un tentativo, ed è fallito) e «Da
 * fatturare» (non è mai partito niente). Il quarto caso è il più insidioso: `fattura: null`,
 * cioè la lista non è riuscita a leggerlo — e allora NON si scrive niente, perché un chip
 * qualunque sarebbe una bugia detta con sicurezza.
 */
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: () => <span data-testid="fattura-button" />,
}));

const movimenti = [
  { id: 'm1', data_operazione: '2026-10-05', importo: 150, causale: 'BONIFICO UNO', controparte: '', stato: 'confermato', pagamento_id: 'pg-1', suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1947/26'] } },
  { id: 'm2', data_operazione: '2026-10-06', importo: 160, causale: 'BONIFICO DUE', controparte: '', stato: 'confermato', pagamento_id: 'pg-2', suggerimenti: [], fattura: { stato: 'scartata', numeri: [] } },
  { id: 'm3', data_operazione: '2026-10-07', importo: 170, causale: 'BONIFICO TRE', controparte: '', stato: 'confermato', pagamento_id: 'pg-3', suggerimenti: [], fattura: { stato: 'da_fatturare', numeri: [] } },
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
    expect(chip.className).toContain('bg-kidville-success-soft');
    expect(chip.className).toContain('text-kidville-success-strong');
    // token via classi, mai hex letterali
    expect(chip.className).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('fattura scartata → chip rosso «Scartata, da riemettere» (non «Da fatturare»)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO DUE/)).toBeInTheDocument());

    const chip = screen.getByText('Scartata, da riemettere');
    expect(chip.className).toContain('bg-kidville-error-soft');
    expect(rigaDi('BONIFICO DUE').textContent).not.toContain('Da fatturare');
  });

  it('nessuna fattura → chip neutro «Da fatturare»', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO TRE/)).toBeInTheDocument());

    const chip = screen.getByText('Da fatturare');
    expect(chip.className).toContain('bg-kidville-neutral-soft');
    expect(rigaDi('BONIFICO TRE')).toContainElement(chip);
  });

  it('fattura non leggibile (null) → NESSUN chip: «non lo so» non si scrive come «no»', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO QUATTRO/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO QUATTRO').textContent ?? '';
    expect(riga).not.toContain('Da fatturare');
    expect(riga).not.toContain('Scartata');
    expect(riga).not.toContain('Fattura');
  });

  it('riga non ancora abbinata → nessun chip (il campo non arriva nemmeno)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO CINQUE/)).toBeInTheDocument());

    const riga = rigaDi('BONIFICO CINQUE').textContent ?? '';
    expect(riga).toContain('Da abbinare'); // l'etichetta a semaforo resta
    expect(riga).not.toContain('Da fatturare');
    expect(riga).not.toContain('Fattura');
  });

  it('senza pagamento_id il chip non compare NEMMENO se il server mandasse una fattura', async () => {
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mx', data_operazione: '2026-10-10', importo: 200, causale: 'BONIFICO SEI', controparte: '', stato: 'suggerito', pagamento_id: null, suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1/26'] } },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO SEI/)).toBeInTheDocument());

    expect(screen.queryByText(/^Fattura /)).toBeNull();
  });

  it('pagamento ripartito su due quote → i due numeri nello stesso chip, uniti da « · »', async () => {
    vi.stubGlobal('fetch', stubFetch([
      { id: 'mq', data_operazione: '2026-10-11', importo: 300, causale: 'BONIFICO SETTE', controparte: '', stato: 'confermato', pagamento_id: 'pg-9', suggerimenti: [], fattura: { stato: 'emessa', numeri: ['FPR 1947/26', 'Asilo 2328/2026'] } },
    ]));
    render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO SETTE/)).toBeInTheDocument());

    expect(screen.getByText('Fattura FPR 1947/26 · Asilo 2328/2026')).toBeInTheDocument();
  });

  it('un solo chip per riga, e solo sulle righe abbinate con esito noto', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const { container } = render(<RiconciliazionePanel userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(screen.getByText(/BONIFICO UNO/)).toBeInTheDocument());

    // 5 righe caricate, 3 con esito noto (emessa/scartata/da_fatturare)
    expect(container.querySelectorAll('li')).toHaveLength(5);
    const chip = [
      ...screen.queryAllByText(/^Fattura /),
      ...screen.queryAllByText('Scartata, da riemettere'),
      ...screen.queryAllByText('Da fatturare'),
    ];
    expect(chip).toHaveLength(3);
  });
});
