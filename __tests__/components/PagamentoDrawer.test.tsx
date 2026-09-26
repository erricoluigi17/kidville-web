import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type React from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { PagamentoDrawer } from '@/components/features/admin/pagamenti/PagamentoDrawer';

/**
 * FatturaButton fa fetch proprie: lo stubbiamo per isolare il drawer.
 *
 * ⚠️ LO STUB REGISTRA LE PROPS (consegna 2b, D5 e D12). Il difetto che il gruppo della coda
 * blocca è *una prop non passata* (`codaStato`, `onEmessa`): uno stub che rende soltanto un
 * segnaposto sarebbe verde con e senza la correzione. Si guarda l'ULTIMA resa.
 */
const spiaFattura = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
  FatturaButton: (props: Record<string, unknown>) => {
    spiaFattura.props.push(props);
    return <span data-testid="fattura-button" />;
  },
}));

const dettaglio = {
  success: true,
  data: {
    id: 'p1',
    descrizione: 'Retta Settembre 2026',
    importo: 150,
    importo_pagato: 150,
    stato: 'pagato',
    tipo: 'singolo',
    fattura_stato: 'non_richiesta',
    scadenza: '2026-09-05',
    alunni: { nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli' },
    payment_categories: { nome: 'Retta', slug: 'retta' },
    incassi: [
      { id: 'i1', importo: 100, data_incasso: '2026-09-03', metodo: 'bonifico', note: null, creato_il: '2026-09-03T10:00:00Z' },
      { id: 'i2', importo: 50, data_incasso: '2026-09-04', metodo: 'contanti', note: 'saldo', creato_il: '2026-09-04T10:00:00Z' },
    ],
    quote: [],
    rate: [],
  },
};

const pagamentoRow = {
  id: 'p1',
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 150,
  stato: 'pagato',
  tipo: 'singolo',
  fattura_stato: 'non_richiesta',
  scadenza: '2026-09-05',
  alunni: { nome: 'Mario', cognome: 'Rossi' },
};

describe('PagamentoDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => dettaglio })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carica il dettaglio e mostra la timeline incassi con i metodi', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(screen.getByText('Retta Settembre 2026')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
    expect(screen.getByText('Contanti')).toBeInTheDocument();
    expect(screen.getByText('saldo')).toBeInTheDocument();
  });

  /**
   * ─── GUARDIA DI REGRESSIONE: LA RICEVUTA NON SI SCARICA PIÙ DA QUI ──────────
   *
   * Questi due casi pretendevano il link «Ricevuta» — attivo a saldo avvenuto,
   * disabilitato prima — verso `GET /api/pagamenti/ricevuta`. Quella rotta è
   * stata CANCELLATA insieme alla ricevuta contabile per singolo pagamento: un
   * link rimasto lì darebbe 404 a chi lo preme, e nessun test se ne
   * accorgerebbe. Il ruolo dei due casi si ribalta: da «il link c'è» a «il link
   * non deve tornare», che è l'unica forma in cui una cancellazione resta
   * cancellata.
   *
   * ⚠️ NON SI ASSERISCE SU UN'ASSENZA E BASTA — un'assenza è verde anche se il
   * drawer non ha rinderizzato niente. Ogni caso pretende anche ciò che DEVE
   * esserci (il pulsante della fattura, il pulsante «Incassa»): senza quella
   * metà la prova passerebbe su una schermata vuota.
   *
   * ⚠️ E NON SI CERCA IL SOLO `link`: il ramo «non saldato» rendeva un `button`
   * disabilitato con la stessa parola. Si cerca il testo, qualunque forma abbia.
   */
  it('pagato → il pulsante della fattura, e NESSUN comando «Ricevuta»', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(await screen.findByTestId('fattura-button')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Incassa' })).toBeNull();
    // Né ancora, né bottone, né testo: la parola non compare più in questa schermata.
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    // E soprattutto: nessun indirizzo verso la rotta che non esiste più.
    expect(document.body.innerHTML).not.toContain('/api/pagamenti/ricevuta');
  });

  it('non saldato → Incassa presente (chiama onIncassa) e nessun comando «Ricevuta»', async () => {
    const row = { ...pagamentoRow, stato: 'da_pagare', importo_pagato: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { ...dettaglio.data, stato: 'da_pagare', importo_pagato: 0, incassi: [] } }),
    })));
    const onIncassa = vi.fn();
    render(
      <PagamentoDrawer pagamento={row} userId="u1" onClose={() => {}}
        onIncassa={onIncassa} onModifica={() => {}} onRateizza={() => {}} />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Incassa' }));
    expect(onIncassa).toHaveBeenCalledTimes(1);
    // Il pulsante spento «Disponibile a saldo avvenuto» non c'è più: prometteva un
    // documento che, a saldo avvenuto, non sarebbe comunque arrivato.
    expect(screen.queryByText(/Ricevuta/i)).toBeNull();
    expect(document.body.innerHTML).not.toContain('/api/pagamenti/ricevuta');
    // Prima del saldo non c'è nemmeno la fattura: il ramo è `saldato && …`.
    expect(screen.queryByTestId('fattura-button')).toBeNull();
  });

  it('uno storno (importo negativo) è etichettato come tale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          ...dettaglio.data,
          incassi: [{ id: 'i3', importo: -50, data_incasso: '2026-09-05', metodo: 'contanti', note: null, creato_il: '2026-09-05T10:00:00Z' }],
        },
      }),
    })));
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    await waitFor(() => expect(screen.getByText('Storno')).toBeInTheDocument());
  });
});

/**
 * ─── LA CODA FATTURE NEL DRAWER (consegna 2b, D5 · D6 · D12, 2026-09-24) ─────
 *
 * Il drawer è la terza strada verso «Invia fattura» (telefono e «Dettagli»): senza
 * `codaStato` il pulsante ricomparirebbe su una riga già in coda (D5), senza `onEmessa`
 * il cruscotto non saprebbe dell'accodamento (D12), e senza `codaStato` sul
 * `FatturaChip` il riepilogo tacerebbe la voce (D6). Il chip è quello VERO (`FatturaChip`
 * non è finto): qui se ne prova il TESTO; che «Errore in coda» sia un collegamento lo prova
 * `FatturaChip.test.tsx`.
 */
describe('PagamentoDrawer — la coda fatture (consegna 2b)', () => {
  beforeEach(() => {
    spiaFattura.props.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => dettaglio })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ultimeProps(): Record<string, unknown> {
    const ultime = spiaFattura.props.at(-1);
    if (!ultime) throw new Error('FatturaButton mai reso');
    return ultime;
  }

  it('errore: al pulsante arrivano `codaStato` ed `onEmessa` (lo stesso `onAccodata`)', async () => {
    const onAccodata = vi.fn();
    render(
      <PagamentoDrawer pagamento={{ ...pagamentoRow, coda_stato: 'errore' as const }} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} onAccodata={onAccodata} />
    );
    expect(await screen.findByTestId('fattura-button')).toBeInTheDocument();
    expect(ultimeProps().codaStato).toBe('errore');
    expect(ultimeProps().onEmessa).toBe(onAccodata);
  });

  it('senza voce: al pulsante arriva `codaStato` null (non assente)', async () => {
    render(
      <PagamentoDrawer pagamento={pagamentoRow} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(await screen.findByTestId('fattura-button')).toBeInTheDocument();
    expect(ultimeProps()).toHaveProperty('codaStato', null);
  });

  it('in_coda: il chip della coda dice «In coda», e il suo contenitore va a capo', async () => {
    render(
      <PagamentoDrawer pagamento={{ ...pagamentoRow, coda_stato: 'in_coda' as const }} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    const chip = await screen.findByTestId('coda-chip');
    expect(chip).toHaveTextContent('In coda');
    // Due chip (fattura e coda) in un riepilogo stretto: il padre deve poter andare a capo.
    expect(chip.parentElement).toHaveClass('flex-wrap');
    // E accanto c'è ancora il chip della fattura: il contenitore li porta tutti e due.
    expect(within(chip.parentElement as HTMLElement).getByText('Da fatturare')).toBeInTheDocument();
  });

  it('errore: il chip della coda dice «Errore in coda»', async () => {
    render(
      <PagamentoDrawer pagamento={{ ...pagamentoRow, coda_stato: 'errore' as const }} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    expect(await screen.findByTestId('coda-chip')).toHaveTextContent('Errore in coda');
  });
});

/**
 * P2b (26/09) — il drawer dice di quale sede è la voce quando le sedi accorpate sono più
 * di una. La sede viene dalla RIGA (`scuola_nome` di `GET /api/pagamenti`), non dal dettaglio.
 */
describe('PagamentoDrawer — sede (P2b)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => dettaglio })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const conSede = { ...pagamentoRow, scuola_nome: 'Kidville Cesa' };

  it('mostraSede: badge con la sede della riga nel riepilogo', async () => {
    render(
      <PagamentoDrawer pagamento={conSede} userId="u1" mostraSede onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
    const badge = screen.getByTestId('sede-badge');
    expect(badge).toHaveTextContent('Kidville Cesa');
    // Letto: tutto tranne `aria-hidden` → la frase del catalogo, col nome UNA volta.
    const letto = badge.cloneNode(true) as HTMLElement;
    letto.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    expect(letto.textContent?.replace(/\s+/g, ' ').trim()).toBe('Sede: Kidville Cesa');
    // Con un nome valido il tono è `neutral` (contratto P2b.md), mai `warn`.
    expect(badge).toHaveClass('bg-kidville-neutral-soft');
    expect(badge).not.toHaveClass('bg-kidville-warn-soft');
  });

  it('mostraSede senza scuola_nome: «Sede non indicata»', async () => {
    render(
      <PagamentoDrawer pagamento={{ ...pagamentoRow, scuola_nome: null }} userId="u1" mostraSede onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
    const badge = screen.getByTestId('sede-badge');
    // Confronto ESATTO: «Sede» una volta sola, non «Sede Sede non indicata».
    expect(badge.textContent?.replace(/\s+/g, ' ').trim()).toBe('Sede non indicata');
    // Una riga senza sede è un'anomalia da notare: tono `warn` (contratto P2b.md).
    expect(badge).toHaveClass('bg-kidville-warn-soft');
    expect(badge).not.toHaveClass('bg-kidville-neutral-soft');
  });

  it('senza mostraSede nessun badge e nessun nome di sede, a dettaglio caricato', async () => {
    render(
      <PagamentoDrawer pagamento={conSede} userId="u1" onClose={() => {}}
        onIncassa={() => {}} onModifica={() => {}} onRateizza={() => {}} />
    );
    // Si aspetta una PRESENZA (il dettaglio arrivato), poi si verifica l'assenza.
    await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
    expect(screen.queryByTestId('sede-badge')).toBeNull();
    expect(document.body.textContent).not.toContain('Kidville Cesa');
  });

  it('senza mostraSede (assente o false) il markup è IDENTICO a quello di una riga senza scuola_nome', async () => {
    // Il drawer può rendere in un portale: si legge `document.body`, e fra un render e
    // l'altro si smonta con cleanup(). Ogni lettura aspetta la PRESENZA del dettaglio.
    const htmlDi = async (ui: React.ReactElement) => {
      render(ui);
      await waitFor(() => expect(screen.getByText('Bonifico')).toBeInTheDocument());
      // `useId` di React dà un id nuovo a ogni montaggio (`_r_b_`, `_r_c_`…): si normalizzano
      // SOLO quelli, perché il confronto riguardi la struttura e non il contatore.
      const html = document.body.innerHTML.replace(/_r_[a-z0-9]+_/g, '_r_ID_');
      // Scheletro (tag + testo, senza classi) della prima riga del riepilogo: è il punto
      // dove P2b interviene. Si confronta con un riferimento FISSO, preso dal markup di
      // HEAD prima di P2b: confrontare fra loro tre render con `mostraSede` spento non
      // vedrebbe un cambio di struttura che li colpisce tutti e tre (es. un wrapper <span>
      // attorno al Badge di stato, la forma del ramo `true`).
      const riepilogo = document.body.querySelectorAll('div.mb-4.rounded-card');
      expect(riepilogo).toHaveLength(1);
      const riga = riepilogo[0].firstElementChild!.outerHTML.replace(/ class="[^"]*"/g, '');
      cleanup();
      return { html, riga };
    };
    const props = { userId: 'u1', onClose: () => {}, onIncassa: () => {}, onModifica: () => {}, onRateizza: () => {} };
    const RIGA_DI_OGGI = '<div><span>Pagato</span><span><span>Da fatturare</span></span></div>';

    const oggi = await htmlDi(<PagamentoDrawer pagamento={pagamentoRow} {...props} />);
    const conSedeAssente = await htmlDi(<PagamentoDrawer pagamento={conSede} {...props} />);
    const conSedeFalse = await htmlDi(<PagamentoDrawer pagamento={conSede} mostraSede={false} {...props} />);

    expect(oggi.html).toContain('Bonifico');
    expect(oggi.riga).toBe(RIGA_DI_OGGI);
    expect(conSedeAssente.html).toBe(oggi.html);
    expect(conSedeFalse.html).toBe(oggi.html);
  });
});
