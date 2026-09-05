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

  it('nessuna fattura, pagamento SALDATO → chip «Da fatturare» (giallo pieno: è l’unico che chiede di agire)', async () => {
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
