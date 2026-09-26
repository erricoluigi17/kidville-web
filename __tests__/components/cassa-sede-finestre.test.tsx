import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { CassaMovimentoModal } from '@/components/features/admin/pagamenti/CassaMovimentoModal';
import { CassaChiusuraModal } from '@/components/features/admin/pagamenti/CassaChiusuraModal';
import { CassaCategorieManager } from '@/components/features/admin/pagamenti/CassaCategorieManager';
import { CassaImpostazioni } from '@/components/features/admin/pagamenti/CassaImpostazioni';
import testi from '../../messages/it/adminContabilita.json';
import testiEn from '../../messages/en/adminContabilita.json';
import { logClient } from '@/lib/logging/client';

// Il log del client è parte della definizione di «fatto» (AGENTS.md): lo si osserva.
vi.mock('@/lib/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/client')>()),
  logClient: vi.fn(),
}));

/**
 * P4b — in Cassa le SCRITTURE sono per sede (decisione del titolare, 26/09).
 *
 * Ogni finestra di scrittura riceve `sedi` e `sedeIniziale`:
 *  - una sola sede → è quella, e il selettore non si mostra;
 *  - più sedi → il selettore è obbligatorio e NON si preseleziona niente «a caso»
 *    (solo `sedeIniziale`, se è una delle sedi offerte).
 *
 * I finti rispondono DIVERSAMENTE a seconda di `scuola_id` (saldo, fondo, categorie
 * cambiano da sede a sede): un componente che leggesse o scrivesse la sede sbagliata
 * mostrerebbe il numero sbagliato o manderebbe il payload sbagliato, e il test lo vede.
 */

const UNA = [{ id: 'sede-a', nome: 'Sede Alfa' }];
const TRE = [
  { id: 'sede-a', nome: 'Sede Alfa' },
  { id: 'sede-b', nome: 'Sede Beta' },
  { id: 'sede-c', nome: 'Sede Gamma' },
];

function jsonRes(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function parametri(u: string) {
  return new URL(u, 'http://localhost').searchParams;
}

type Chiamata = { url: string; metodo: string; corpo: Record<string, unknown> | null };

/** Un finto `fetch` che registra ogni chiamata e risponde per sede. */
function finto(risposta: (c: Chiamata) => Response | Promise<Response>) {
  const chiamate: Chiamata[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const c: Chiamata = {
      url: String(url),
      metodo: init?.method ?? 'GET',
      corpo: init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    chiamate.push(c);
    return risposta(c);
  });
  vi.stubGlobal('fetch', fn);
  return chiamate;
}

const selettoreSede = () => screen.queryByRole('combobox', { name: testi.cassaSedeLabel });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(logClient).mockClear();
  cleanup();
});

// ─── Nessuna sede: le quattro finestre lo dicono SUBITO, senza leggere niente ──

describe('Nessuna sede (sedi = []): il messaggio compare subito, nessuna lettura e nessuna scrittura', () => {
  it('Movimento: «Nessuna sede disponibile» al posto del form, niente «Salva», niente «Prima scegli la sede»', async () => {
    const chiamate = finto(rispostaMovimento);
    render(<CassaMovimentoModal userId="u1" sedi={[]} sedeIniziale={null} tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(testi.cassaSedeNessuna)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Salva/ })).toBeNull();
    expect(screen.queryByText(testi.cassaSedePrimaLaSede)).toBeNull();
    expect(screen.queryByLabelText(/Importo/)).toBeNull();
    expect(selettoreSede()).toBeNull();
    expect(chiamate).toHaveLength(0);
  });

  it('Svuota cassa: «Nessuna sede disponibile», niente saldo né «Conferma»', async () => {
    const chiamate = finto(rispostaChiusura);
    render(<CassaChiusuraModal userId="u1" sedi={[]} sedeIniziale={null} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText(testi.cassaSedeNessuna)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conferma/ })).toBeNull();
    expect(chiamate).toHaveLength(0);
  });

  it('Categorie: «Nessuna sede disponibile», niente campo di aggiunta', async () => {
    const chiamate = finto(() => jsonRes({ disponibile: true, categorie: [] }));
    render(<CassaCategorieManager userId="u1" sedi={[]} sedeIniziale={null} />);
    expect(await screen.findByText(testi.cassaSedeNessuna)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(chiamate).toHaveLength(0);
  });

  it('Impostazioni: «Nessuna sede disponibile», niente campi né «Salva»', async () => {
    const chiamate = finto(() => jsonRes({ success: true, data: {} }));
    render(<CassaImpostazioni userId="u1" sedi={[]} sedeIniziale={null} />);
    expect(await screen.findByText(testi.cassaSedeNessuna)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: testi.cassaCfgSalva })).toBeNull();
    expect(chiamate).toHaveLength(0);
  });
});

// ─── CassaMovimentoModal ─────────────────────────────────────────────────────

const CATEGORIE: Record<string, { id: string; nome: string }[]> = {
  'sede-a': [{ id: 'cat-a', nome: 'Pulizie Alfa' }],
  'sede-b': [{ id: 'cat-b', nome: 'Cancelleria Beta' }],
  'sede-c': [{ id: 'cat-c', nome: 'Manutenzione Gamma' }],
};

function categorieDi(sede: string | null) {
  return (CATEGORIE[sede ?? ''] ?? []).map((c, i) => ({
    ...c, scuola_id: sede, slug: c.id, colore: null, icona: null, ordine: i, attivo: true, is_sistema: false,
  }));
}

function rispostaMovimento(c: Chiamata) {
  if (c.url.includes('/cassa/categorie')) {
    return jsonRes({ disponibile: true, categorie: categorieDi(parametri(c.url).get('scuola_id')) });
  }
  if (c.url.includes('/cassa/allegato/upload-url')) {
    const sede = String(c.corpo?.scuola_id);
    return jsonRes({ success: true, data: { path: `${sede}/2026/x.jpg`, signedUrl: 'https://signed.example/put' } });
  }
  if (c.metodo === 'PUT') return jsonRes({});
  if (c.url.includes('/cassa/movimenti')) return jsonRes({ movimento: { id: 'm1' } }, 201);
  return jsonRes({});
}

describe('CassaMovimentoModal — sede della scrittura', () => {
  it('UNA sede: nessun selettore, categorie e movimento vanno su quella sede', async () => {
    const chiamate = finto(rispostaMovimento);
    const onDone = vi.fn();
    render(<CassaMovimentoModal userId="u1" sedi={UNA} sedeIniziale={null} tipoIniziale="uscita" onClose={() => {}} onDone={onDone} />);

    // Le categorie della sede unica arrivano (presenza, non assenza).
    const categoria = await screen.findByRole('option', { name: 'Pulizie Alfa' });
    expect(selettoreSede()).toBeNull();
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: (categoria as HTMLOptionElement).value } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = chiamate.filter((c) => c.url.includes('/cassa/movimenti'));
    expect(post).toHaveLength(1);
    expect(post[0].corpo).toMatchObject({ scuola_id: 'sede-a', categoria_id: 'cat-a', importo: 12 });
  });

  it('PIÙ sedi, nessuna iniziale: niente preselezione, il salvataggio è bloccato finché non si sceglie', async () => {
    const chiamate = finto(rispostaMovimento);
    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale={null} tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);

    const sel = await screen.findByRole('combobox', { name: testi.cassaSedeLabel });
    expect((sel as HTMLSelectElement).value).toBe('');
    // La scelta è obbligatoria e lo si dichiara PRIMA del salvataggio (WCAG 3.3.2 / 4.1.2).
    expect(sel).toHaveAttribute('aria-required', 'true');
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(testi.cassaSedeObbligatoria);
    expect(sel).toHaveAttribute('aria-invalid', 'true');
    expect(sel.getAttribute('aria-describedby')).toBe(alert.id);
    // Nessuna scrittura, e nessuna lettura di categorie «indovinando» una sede.
    expect(chiamate.filter((c) => c.url.includes('/cassa/movimenti'))).toHaveLength(0);
    expect(chiamate.filter((c) => c.url.includes('/cassa/categorie'))).toHaveLength(0);
  });

  it('PIÙ sedi: scelta Beta → categorie di Beta, allegato e movimento con scuola_id Beta', async () => {
    const chiamate = finto(rispostaMovimento);
    const onDone = vi.fn();
    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale={null} tipoIniziale="uscita" onClose={() => {}} onDone={onDone} />);

    fireEvent.change(await screen.findByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByRole('option', { name: 'Cancelleria Beta' });
    expect(screen.queryByRole('option', { name: 'Pulizie Alfa' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'cat-b' } });
    fireEvent.change(screen.getByLabelText(/Foto/i), { target: { files: [new File(['x'], 'scontrino.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const up = chiamate.filter((c) => c.url.includes('/allegato/upload-url'));
    expect(up).toHaveLength(1);
    expect(up[0].corpo).toMatchObject({ scuola_id: 'sede-b' });
    const post = chiamate.filter((c) => c.url.includes('/cassa/movimenti'));
    expect(post[0].corpo).toMatchObject({ scuola_id: 'sede-b', categoria_id: 'cat-b', allegato_path: 'sede-b/2026/x.jpg' });
  });

  it('cambiare sede azzera la categoria scelta: una categoria di Alfa non parte mai con la sede Beta', async () => {
    const chiamate = finto(rispostaMovimento);
    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale="sede-a" tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);

    await screen.findByRole('option', { name: 'Pulizie Alfa' });
    fireEvent.change(screen.getByLabelText(/Categoria/), { target: { value: 'cat-a' } });
    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByRole('option', { name: 'Cancelleria Beta' });
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaMovCategoriaUscita);
    expect(chiamate.filter((c) => c.url.includes('/cassa/movimenti'))).toHaveLength(0);
  });

  it('un 400 del server su `scuola_id` marca il selettore della sede (aria-invalid + aria-describedby)', async () => {
    const chiamate = finto((c) => {
      if (c.url.includes('/cassa/movimenti')) {
        return jsonRes({ error: 'Dati non validi', details: [{ path: 'scuola_id', message: 'sede non valida' }] }, 400);
      }
      return rispostaMovimento(c);
    });
    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale="sede-b" tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);
    const sel = await screen.findByRole('combobox', { name: testi.cassaSedeLabel });
    expect(sel).not.toHaveAttribute('aria-invalid');
    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(testi.cassaMovCampoSede);
    expect(chiamate.filter((c) => c.url.includes('/cassa/movimenti'))).toHaveLength(1);
    expect(sel).toHaveAttribute('aria-invalid', 'true');
    expect(sel.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
  });

  /**
   * Giro 3: una GET delle categorie RIFIUTATA (403 `SEDE_NON_ACCESSIBILE`, 500) non è un
   * elenco vuoto. Prima il corpo `{ error, codice }` finiva nel select come «nessuna
   * categoria», e «Salva» rispondeva «seleziona una categoria», che porta fuori strada.
   */
  it('categorie della sede RIFIUTATE (403): avviso accanto alla categoria, log con lo stato, nessuna uscita salvata', async () => {
    const chiamate = finto((c) => {
      if (c.url.includes('/cassa/categorie')) return jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, 403);
      return rispostaMovimento(c);
    });
    render(<CassaMovimentoModal userId="u1" sedi={UNA} sedeIniziale={null} tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);

    const avviso = await screen.findByRole('alert');
    expect(avviso).toHaveTextContent(testi.cassaMovCatErrLettura);
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-categorie-lettura-rifiutata', stato: 403 }));
    // Il select della categoria rimanda all'avviso, invece di presentarsi come un elenco vuoto valido.
    const sel = screen.getByLabelText(/Categoria/);
    expect(sel).toBeDisabled();
    expect(sel.getAttribute('aria-describedby')).toBe(avviso.id);

    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaMovCatErrLettura);
    expect(screen.queryByText(testi.cassaMovCategoriaUscita)).toBeNull();
    expect(sel).toHaveAttribute('aria-invalid', 'true');
    expect(chiamate.filter((c) => c.url.includes('/cassa/movimenti'))).toHaveLength(0);
  });

  it('categorie RIFIUTATE (500) su Alfa, poi Beta: l’avviso va via e compaiono le categorie di Beta', async () => {
    finto((c) => {
      if (c.url.includes('/cassa/categorie') && parametri(c.url).get('scuola_id') === 'sede-a') return jsonRes({ error: 'Errore' }, 500);
      return rispostaMovimento(c);
    });
    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale="sede-a" tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaMovCatErrLettura);
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'cassa-categorie-lettura-rifiutata', stato: 500 }));

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByRole('option', { name: 'Cancelleria Beta' });
    expect(screen.queryByText(testi.cassaMovCatErrLettura)).toBeNull();
    expect(screen.getByLabelText(/Categoria/)).toBeEnabled();
  });

  /**
   * Giro 4: anche un errore di RETE (la fetch rifiutata, nessuna risposta) è una lettura
   * fallita, non «nessuna categoria». Senza `setCategorieFallitePer` nel `catch` il select
   * tornerebbe un elenco vuoto «valido» e «Salva» risponderebbe «seleziona una categoria».
   */
  it('categorie in errore di RETE: avviso accanto alla categoria, log con stato 0, nessuna uscita salvata', async () => {
    const chiamate = finto((c) => {
      if (c.url.includes('/cassa/categorie')) return Promise.reject(new TypeError('Failed to fetch'));
      return rispostaMovimento(c);
    });
    render(<CassaMovimentoModal userId="u1" sedi={UNA} sedeIniziale={null} tipoIniziale="uscita" onClose={() => {}} onDone={() => {}} />);

    const avviso = await screen.findByRole('alert');
    expect(avviso).toHaveTextContent(testi.cassaMovCatErrLettura);
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error', messaggio: expect.stringContaining('cassa-categorie-caricamento-fallito'), stato: 0,
    }));
    const sel = screen.getByLabelText(/Categoria/);
    expect(sel).toBeDisabled();
    expect(sel.getAttribute('aria-describedby')).toBe(avviso.id);

    fireEvent.change(screen.getByLabelText(/Importo/), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaMovCatErrLettura);
    expect(screen.queryByText(testi.cassaMovCategoriaUscita)).toBeNull();
    expect(chiamate.filter((c) => c.url.includes('/cassa/movimenti'))).toHaveLength(0);
  });

  it('PIÙ sedi con sedeIniziale fra quelle offerte: è preselezionata; una sedeIniziale estranea NO', async () => {
    finto(rispostaMovimento);
    const { unmount } = render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale="sede-c" tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);
    expect(((await screen.findByRole('combobox', { name: testi.cassaSedeLabel })) as HTMLSelectElement).value).toBe('sede-c');
    unmount();

    render(<CassaMovimentoModal userId="u1" sedi={TRE} sedeIniziale="sede-estranea" tipoIniziale="entrata" onClose={() => {}} onDone={() => {}} />);
    expect(((await screen.findByRole('combobox', { name: testi.cassaSedeLabel })) as HTMLSelectElement).value).toBe('');
  });
});

// ─── CassaChiusuraModal ──────────────────────────────────────────────────────

const SALDI: Record<string, { fondo: number; saldo_atteso: number }> = {
  'sede-a': { fondo: 100, saldo_atteso: 130 },
  'sede-b': { fondo: 50, saldo_atteso: 777 },
  'sede-c': { fondo: 80, saldo_atteso: 412 },
};

function saldoDi(sede: string) {
  const s = SALDI[sede];
  return {
    disponibile: true, ...s, entrate_contanti: 0, uscite_contanti: 0, prelievi: 0, rettifiche: 0, entrato_oggi: [],
    per_sede: [{ scuola_id: sede, scuola_nome: null, disponibile: true, ...s }],
  };
}

function rispostaChiusura(c: Chiamata) {
  if (c.url.includes('/cassa/saldo')) return jsonRes(saldoDi(String(parametri(c.url).get('scuola_id'))));
  if (c.url.includes('/cassa/chiusura')) {
    return jsonRes({ chiusura_id: 'ch1', saldo_atteso: 777, contato: 700, differenza: -77, prelevato: 650, fondo_lasciato: 50 }, 201);
  }
  return jsonRes({});
}

describe('CassaChiusuraModal — il saldo e lo svuotamento sono della sede scelta', () => {
  it('UNA sede: nessun selettore, saldo e svuotamento di quella sede', async () => {
    const chiamate = finto(rispostaChiusura);
    render(<CassaChiusuraModal userId="u1" sedi={UNA} sedeIniziale={null} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(/€ 130,00/);
    expect(selettoreSede()).toBeNull();
    fireEvent.change(screen.getByLabelText(/Totale contato/), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: /Conferma/ }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'POST')?.corpo).toMatchObject({ scuola_id: 'sede-a', contato: 120 });
  });

  it('PIÙ sedi: finché non si sceglie non si legge nessun saldo e non si può svuotare; scelta Beta → saldo e POST di Beta', async () => {
    const chiamate = finto(rispostaChiusura);
    render(<CassaChiusuraModal userId="u1" sedi={TRE} sedeIniziale={null} onClose={() => {}} onDone={() => {}} />);

    expect(await screen.findByText(testi.cassaSedeScegliPerSaldo)).toBeInTheDocument();
    const sel = screen.getByRole('combobox', { name: testi.cassaSedeLabel });
    expect((sel as HTMLSelectElement).value).toBe('');
    expect(screen.queryByRole('button', { name: /Conferma/ })).toBeNull();
    expect(screen.queryByLabelText(/Totale contato/)).toBeNull();
    expect(chiamate.filter((c) => c.url.includes('/cassa/saldo'))).toHaveLength(0);

    fireEvent.change(sel, { target: { value: 'sede-b' } });
    await screen.findByText(/€ 777,00/);
    expect(screen.getByText(/€ 50,00/)).toBeInTheDocument(); // il fondo di Beta, non quello di Alfa
    fireEvent.change(screen.getByLabelText(/Totale contato/), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: /Conferma/ }));

    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(1));
    const post = chiamate.find((c) => c.metodo === 'POST');
    expect(Object.keys(post?.corpo ?? {}).sort()).toEqual(['contato', 'note', 'scuola_id']);
    expect(post?.corpo).toMatchObject({ scuola_id: 'sede-b', contato: 700 });
    expect(parametri(chiamate.filter((c) => c.url.includes('/cassa/saldo'))[0].url).get('scuola_id')).toBe('sede-b');
  });

  it('cambio di sede con la risposta della prima IN RITARDO: resta il saldo della sede scelta per ultima', async () => {
    let sbloccaAlfa: (r: Response) => void = () => {};
    finto((c) => {
      if (c.url.includes('/cassa/saldo') && parametri(c.url).get('scuola_id') === 'sede-a') {
        return new Promise<Response>((ok) => { sbloccaAlfa = ok; });
      }
      return rispostaChiusura(c);
    });
    render(<CassaChiusuraModal userId="u1" sedi={TRE} sedeIniziale="sede-a" onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(testi.cassaChiuCaricamentoSaldo);
    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-c' } });
    await screen.findByText(/€ 412,00/);
    await act(async () => { sbloccaAlfa(jsonRes(saldoDi('sede-a'))); });
    expect(screen.getByText(/€ 412,00/)).toBeInTheDocument();
    expect(screen.queryByText(/€ 130,00/)).toBeNull();
  });

  it('saldo della sede RIFIUTATO (403): «impossibile leggere il saldo», niente form e niente svuotamento', async () => {
    const chiamate = finto((c) => {
      if (c.url.includes('/cassa/saldo')) return jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, 403);
      return rispostaChiusura(c);
    });
    render(<CassaChiusuraModal userId="u1" sedi={UNA} sedeIniziale={null} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaChiuErrSaldo);
    expect(screen.queryByText(testi.cassaChiuNonAttivo)).toBeNull();
    expect(screen.queryByRole('button', { name: /Conferma/ })).toBeNull();
    expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(0);
    // Il rifiuto lascia una traccia di livello `error` con lo stato HTTP (AGENTS.md, logging).
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-saldo-rifiutato', stato: 403 }));
  });

  it('cambio di sede: il «Totale contato» riparte vuoto (era il cassetto dell’altra sede)', async () => {
    finto(rispostaChiusura);
    render(<CassaChiusuraModal userId="u1" sedi={TRE} sedeIniziale="sede-a" onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(/€ 130,00/);
    fireEvent.change(screen.getByLabelText(/Totale contato/), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText(testi.cassaChiuNote), { target: { value: 'conta del mattino' } });
    expect(screen.getByLabelText(/Totale contato/)).toHaveValue(120);
    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByText(/€ 777,00/);
    expect(screen.getByLabelText(/Totale contato/)).toHaveValue(null);
    expect(screen.getByLabelText(testi.cassaChiuNote)).toHaveValue('');
    // Senza contato non c'è differenza calcolata contro il saldo di Beta.
    expect(screen.queryByText(testi.cassaChiuDifferenzaDiCassa)).toBeNull();
  });
});

// ─── CassaCategorieManager ───────────────────────────────────────────────────

describe('CassaCategorieManager — le categorie si gestiscono sede per sede', () => {
  it('UNA sede: nessun selettore; lettura, aggiunta ed eliminazione su quella sede', async () => {
    const chiamate = finto((c) => {
      if (c.metodo === 'GET') return jsonRes({ disponibile: true, categorie: categorieDi(parametri(c.url).get('scuola_id')) });
      return jsonRes({ categoria: { id: 'nuova' } }, c.metodo === 'POST' ? 201 : 200);
    });
    render(<CassaCategorieManager userId="u1" sedi={UNA} sedeIniziale={null} />);
    await screen.findByText('Pulizie Alfa');
    expect(selettoreSede()).toBeNull();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Giardino' } });
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCatAggiungi }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'POST')?.corpo).toMatchObject({ scuola_id: 'sede-a', nome: 'Giardino' });

    fireEvent.click(screen.getByRole('button', { name: `${testi.cassaCatElimina} Pulizie Alfa` }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'DELETE')).toHaveLength(1));
    const del = parametri(chiamate.find((c) => c.metodo === 'DELETE')!.url);
    expect(del.get('scuola_id')).toBe('sede-a');
    expect(del.get('id')).toBe('cat-a');
  });

  it('PIÙ sedi: niente elenco né campo finché non si sceglie; scelta Gamma → GET, POST e DELETE con Gamma', async () => {
    const chiamate = finto((c) => {
      if (c.metodo === 'GET') return jsonRes({ disponibile: true, categorie: categorieDi(parametri(c.url).get('scuola_id')) });
      return jsonRes({ ok: true }, c.metodo === 'POST' ? 201 : 200);
    });
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale={null} />);

    expect(await screen.findByText(testi.cassaSedeScegliPerCategorie)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(chiamate).toHaveLength(0);

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-c' } });
    await screen.findByText('Manutenzione Gamma');
    expect(parametri(chiamate[0].url).get('scuola_id')).toBe('sede-c');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Giardino' } });
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCatAggiungi }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'POST')?.corpo).toMatchObject({ scuola_id: 'sede-c', nome: 'Giardino' });

    fireEvent.click(screen.getByRole('button', { name: `${testi.cassaCatElimina} Manutenzione Gamma` }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'DELETE')).toHaveLength(1));
    expect(parametri(chiamate.find((c) => c.metodo === 'DELETE')!.url).get('scuola_id')).toBe('sede-c');
  });

  it('cambio di sede con la lettura della prima IN RITARDO: restano le categorie della sede scelta per ultima', async () => {
    let sbloccaAlfa: (r: Response) => void = () => {};
    finto((c) => {
      const sede = parametri(c.url).get('scuola_id');
      if (sede === 'sede-a') return new Promise<Response>((ok) => { sbloccaAlfa = ok; });
      return jsonRes({ disponibile: true, categorie: categorieDi(sede) });
    });
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    fireEvent.change(await screen.findByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByText('Cancelleria Beta');
    await act(async () => { sbloccaAlfa(jsonRes({ disponibile: true, categorie: categorieDi('sede-a') })); });
    expect(screen.getByText('Cancelleria Beta')).toBeInTheDocument();
    expect(screen.queryByText('Pulizie Alfa')).toBeNull();
  });

  /**
   * Una scrittura in volo su Alfa, poi (se il cambio passa comunque) Beta: all'arrivo della
   * risposta del POST la rilettura NON deve essere quella di Alfa. Prima `add` richiamava il
   * `load` catturato al render di Alfa, che prendeva il numero di lettura più alto e scriveva
   * le categorie di Alfa sotto il selettore su Beta.
   */
  function fintoConPostSospeso() {
    let sbloccaPost: (r: Response) => void = () => {};
    const chiamate = finto((c) => {
      if (c.metodo === 'POST') return new Promise<Response>((ok) => { sbloccaPost = ok; });
      return jsonRes({ disponibile: true, categorie: categorieDi(parametri(c.url).get('scuola_id')) });
    });
    return { chiamate, sblocca: (r: Response) => sbloccaPost(r) };
  }

  async function aggiungiSuAlfaEPassaABeta(chiamate: Chiamata[]) {
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    await screen.findByText('Pulizie Alfa');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Giardino' } });
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCatAggiungi }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(1));

    // Durante la scrittura il selettore, «Aggiungi» e i cestini sono fermi.
    const sel = screen.getByRole('combobox', { name: testi.cassaSedeLabel });
    expect(sel).toBeDisabled();
    expect(screen.getByRole('button', { name: testi.cassaCatAggiungi })).toBeDisabled();
    expect(screen.getByRole('button', { name: `${testi.cassaCatElimina} Pulizie Alfa` })).toBeDisabled();

    // Anche se il cambio arrivasse comunque (evento programmatico), la sede nuova vince.
    fireEvent.change(sel, { target: { value: 'sede-b' } });
    await screen.findByText('Cancelleria Beta');
  }

  it('POST di Alfa in volo, poi Beta: alla risposta restano le categorie di Beta, nessuna rilettura di Alfa', async () => {
    const { chiamate, sblocca } = fintoConPostSospeso();
    await aggiungiSuAlfaEPassaABeta(chiamate);
    const lettureAlfaPrima = chiamate.filter((c) => c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a').length;

    await act(async () => { sblocca(jsonRes({ categoria: { id: 'nuova' } }, 201)); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Cancelleria Beta')).toBeInTheDocument();
    expect(screen.queryByText('Pulizie Alfa')).toBeNull();
    expect(chiamate.filter((c) => c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a')).toHaveLength(lettureAlfaPrima);
  });

  it('POST di Alfa in volo che FALLISCE dopo il passaggio a Beta: il suo errore non compare sotto Beta', async () => {
    const { chiamate, sblocca } = fintoConPostSospeso();
    await aggiungiSuAlfaEPassaABeta(chiamate);

    await act(async () => { sblocca(jsonRes({ error: 'Nome già usato' }, 409)); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Cancelleria Beta')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Nome già usato')).toBeNull();
  });

  /**
   * Giro 3: una GET rifiutata (403/500) non è «questa sede non ha categorie». Prima il corpo
   * `{ error, codice }` passava per un elenco vuoto: zero chip e il campo «Aggiungi».
   */
  it('lettura delle categorie RIFIUTATA (403): avviso, niente elenco né campo di aggiunta, log con lo stato', async () => {
    const chiamate = finto(() => jsonRes({ error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }, 403));
    render(<CassaCategorieManager userId="u1" sedi={UNA} sedeIniziale={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCatErrLettura);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: testi.cassaCatAggiungi })).toBeNull();
    expect(screen.queryByText(testi.cassaCatSistemaHint)).toBeNull();
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-categorie-lettura-rifiutata', stato: 403 }));
    expect(chiamate.filter((c) => c.metodo !== 'GET')).toHaveLength(0);
  });

  it('lettura RIFIUTATA (500) su Alfa, poi Beta: l’avviso non resta sotto Beta, che si legge normalmente', async () => {
    finto((c) => {
      const sede = parametri(c.url).get('scuola_id');
      if (sede === 'sede-a') return jsonRes({ error: 'Errore interno' }, 500);
      return jsonRes({ disponibile: true, categorie: categorieDi(sede) });
    });
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCatErrLettura);
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'cassa-categorie-lettura-rifiutata', stato: 500 }));

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    await screen.findByText('Cancelleria Beta');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  /**
   * Giro 4: la lettura in errore di RETE su Alfa (fetch rifiutata) è una lettura fallita come
   * un 403/500. Senza `setFallitaPer` nel `.catch` il manager mostrerebbe un elenco vuoto col
   * campo «Aggiungi», come se Alfa non avesse categorie.
   */
  it('lettura in errore di RETE su Alfa: avviso, niente campo, log con stato 0; poi Beta si legge', async () => {
    const chiamate = finto((c) => {
      const sede = parametri(c.url).get('scuola_id');
      if (c.metodo === 'GET' && sede === 'sede-a') return Promise.reject(new TypeError('Failed to fetch'));
      return jsonRes({ disponibile: true, categorie: categorieDi(sede) });
    });
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCatErrLettura);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error', messaggio: expect.stringContaining('cassa-categorie-caricamento-fallito'), stato: 0,
    }));

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    expect(await screen.findAllByText('Cancelleria Beta')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(chiamate.filter((c) => c.metodo !== 'GET')).toHaveLength(0);
  });

  it('DELETE di Alfa in volo, poi Beta: alla risposta nessuna rilettura di Alfa, restano le categorie di Beta', async () => {
    let sbloccaDelete: (r: Response) => void = () => {};
    const chiamate = finto((c) => {
      if (c.metodo === 'DELETE') return new Promise<Response>((ok) => { sbloccaDelete = ok; });
      return jsonRes({ disponibile: true, categorie: categorieDi(parametri(c.url).get('scuola_id')) });
    });
    render(<CassaCategorieManager userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    fireEvent.click(await screen.findByRole('button', { name: `${testi.cassaCatElimina} Pulizie Alfa` }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'DELETE')).toHaveLength(1));
    const sel = screen.getByRole('combobox', { name: testi.cassaSedeLabel });
    expect(sel).toBeDisabled();

    fireEvent.change(sel, { target: { value: 'sede-b' } });
    await screen.findByText('Cancelleria Beta');
    const lettureAlfaPrima = chiamate.filter((c) => c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a').length;

    await act(async () => { sbloccaDelete(jsonRes({ error: 'Categoria di sistema' }, 409)); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Cancelleria Beta')).toBeInTheDocument();
    expect(screen.queryByText('Pulizie Alfa')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chiamate.filter((c) => c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a')).toHaveLength(lettureAlfaPrima);
  });
});

// ─── CassaImpostazioni ───────────────────────────────────────────────────────

const CONFIG: Record<string, { fondo: number; soglia_avviso: number }> = {
  'sede-a': { fondo: 100, soglia_avviso: 1000 },
  'sede-b': { fondo: 250, soglia_avviso: 2500 },
  'sede-c': { fondo: 90, soglia_avviso: 900 },
};

function rispostaImpostazioni(c: Chiamata) {
  if (c.metodo === 'GET') {
    return jsonRes({ success: true, data: { cassa_config: CONFIG[String(parametri(c.url).get('scuola_id'))] } });
  }
  return jsonRes({ success: true });
}

describe('CassaImpostazioni — fondo e soglia sono di ogni sede', () => {
  it('UNA sede: nessun selettore; lettura e PATCH su quella sede', async () => {
    const chiamate = finto(rispostaImpostazioni);
    render(<CassaImpostazioni userId="u1" sedi={UNA} sedeIniziale={null} />);
    expect(await screen.findByDisplayValue('100')).toBeInTheDocument();
    expect(selettoreSede()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCfgSalva }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'PATCH')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'PATCH')?.corpo).toEqual({ scuola_id: 'sede-a', cassa_config: { fondo: 100, soglia_avviso: 1000 } });
  });

  it('PIÙ sedi: niente campi finché non si sceglie; scelta Beta → valori di Beta e PATCH con Beta', async () => {
    const chiamate = finto(rispostaImpostazioni);
    render(<CassaImpostazioni userId="u1" sedi={TRE} sedeIniziale={null} />);

    expect(await screen.findByText(testi.cassaSedeScegliPerImpostazioni)).toBeInTheDocument();
    expect(screen.queryByLabelText(testi.cassaCfgFondoLabel)).toBeNull();
    expect(screen.queryByRole('button', { name: testi.cassaCfgSalva })).toBeNull();
    expect(chiamate).toHaveLength(0);

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    expect(await screen.findByDisplayValue('250')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(testi.cassaCfgFondoLabel), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCfgSalva }));

    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'PATCH')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'PATCH')?.corpo).toEqual({ scuola_id: 'sede-b', cassa_config: { fondo: 300, soglia_avviso: 2500 } });
  });

  it('passando da Beta a Gamma si rileggono i valori: il fondo di Beta non finisce su Gamma', async () => {
    const chiamate = finto(rispostaImpostazioni);
    render(<CassaImpostazioni userId="u1" sedi={TRE} sedeIniziale="sede-b" />);
    expect(await screen.findByDisplayValue('250')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-c' } });
    expect(await screen.findByDisplayValue('90')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('250')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: testi.cassaCfgSalva }));
    await waitFor(() => expect(chiamate.filter((c) => c.metodo === 'PATCH')).toHaveLength(1));
    expect(chiamate.find((c) => c.metodo === 'PATCH')?.corpo).toEqual({ scuola_id: 'sede-c', cassa_config: { fondo: 90, soglia_avviso: 900 } });
  });

  it('cambio di sede con la lettura della prima IN RITARDO: restano i valori della sede scelta per ultima', async () => {
    let sbloccaAlfa: (r: Response) => void = () => {};
    finto((c) => {
      if (c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a') return new Promise<Response>((ok) => { sbloccaAlfa = ok; });
      return rispostaImpostazioni(c);
    });
    render(<CassaImpostazioni userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    fireEvent.change(await screen.findByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-c' } });
    expect(await screen.findByDisplayValue('90')).toBeInTheDocument();
    await act(async () => { sbloccaAlfa(jsonRes({ success: true, data: { cassa_config: CONFIG['sede-a'] } })); });
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('100')).toBeNull();
  });

  /**
   * Una lettura andata male NON deve aprire campi vuoti e «Salva»: un clic manderebbe
   * `{ fondo: 0, soglia_avviso: null }` sopra il fondo VERO di quella sede.
   */
  it('lettura della sede RIFIUTATA (500): avviso, niente campi, niente «Salva», nessuna PATCH, log di livello error', async () => {
    const chiamate = finto((c) => {
      if (c.metodo === 'GET') return jsonRes({ success: false, error: 'Errore interno' }, 500);
      return rispostaImpostazioni(c);
    });
    render(<CassaImpostazioni userId="u1" sedi={UNA} sedeIniziale={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCfgErrLettura);
    expect(screen.queryByLabelText(testi.cassaCfgFondoLabel)).toBeNull();
    expect(screen.queryByLabelText(testi.cassaCfgSogliaLabel)).toBeNull();
    expect(screen.queryByRole('button', { name: testi.cassaCfgSalva })).toBeNull();
    expect(chiamate.filter((c) => c.metodo === 'PATCH')).toHaveLength(0);
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'cassa-impostazioni-lettura-rifiutata', stato: 500 }));
  });

  it('risposta 200 con `success: false`: è una lettura fallita, non una configurazione vuota', async () => {
    finto((c) => (c.metodo === 'GET' ? jsonRes({ success: false }) : rispostaImpostazioni(c)));
    render(<CassaImpostazioni userId="u1" sedi={UNA} sedeIniziale={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCfgErrLettura);
    expect(screen.queryByRole('button', { name: testi.cassaCfgSalva })).toBeNull();
  });

  it('lettura in errore di RETE con più sedi: avviso sotto il selettore, che resta usabile; Beta poi si legge', async () => {
    const chiamate = finto((c) => {
      if (c.metodo === 'GET' && parametri(c.url).get('scuola_id') === 'sede-a') return Promise.reject(new TypeError('Failed to fetch'));
      return rispostaImpostazioni(c);
    });
    render(<CassaImpostazioni userId="u1" sedi={TRE} sedeIniziale="sede-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(testi.cassaCfgErrLettura);
    expect(screen.queryByRole('button', { name: testi.cassaCfgSalva })).toBeNull();
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 0 }));

    fireEvent.change(screen.getByRole('combobox', { name: testi.cassaSedeLabel }), { target: { value: 'sede-b' } });
    expect(await screen.findByDisplayValue('250')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chiamate.filter((c) => c.metodo === 'PATCH')).toHaveLength(0);
  });
});

describe('i18n P4b: le chiavi nuove esistono in italiano e in inglese', () => {
  it('cassaCfgErrLettura è tradotta in entrambe le lingue', () => {
    expect(typeof testi.cassaCfgErrLettura).toBe('string');
    expect(typeof testiEn.cassaCfgErrLettura).toBe('string');
    expect(testiEn.cassaCfgErrLettura).not.toBe(testi.cassaCfgErrLettura);
  });

  it('cassaCatErrLettura e cassaMovCatErrLettura (giro 3) sono tradotte in entrambe le lingue', () => {
    for (const k of ['cassaCatErrLettura', 'cassaMovCatErrLettura'] as const) {
      expect(typeof testi[k]).toBe('string');
      expect(typeof testiEn[k]).toBe('string');
      expect(testiEn[k]).not.toBe(testi[k]);
    }
  });
});
