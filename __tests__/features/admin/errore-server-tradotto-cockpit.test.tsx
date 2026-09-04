import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

import { CassaCategorieManager } from '@/components/features/admin/pagamenti/CassaCategorieManager';
import { FatturaButton } from '@/components/features/admin/pagamenti/FatturaButton';
import en from '../../../messages/en/shared.json';
import sharedIt from '../../../messages/it/shared.json';
import itContabilita from '../../../messages/it/adminContabilita.json';

/**
 * T10-F1 nel COCKPIT — l'errore del server in italiano dentro l'app in inglese.
 *
 * ─── PERCHÉ UN TEST CHE MONTA, E NON UN grep ────────────────────────────────
 * Il lock `errori-server-schermate-famiglia.test.ts` sa dire che nessuno LEGGE
 * più `j.error`; non sa dire che il testo che finisce a schermo è quello giusto.
 * Un componente che chiamasse `messaggioDaCorpo` e ne buttasse via il ritorno
 * passerebbe il lock e mostrerebbe comunque la frase sbagliata. Questi test
 * guardano il DOM.
 *
 * ─── COME È ARMATO ──────────────────────────────────────────────────────────
 * `messaggioDaCorpo` non passa da next-intl: importa i due cataloghi e legge la
 * lingua da `document.documentElement.lang` (che in produzione scrive
 * `RootLayout`). Nei test `next-intl` è finto e risolve sempre in ITALIANO — ed
 * è esattamente ciò che rende la misura interessante: con `lang="en"` il testo
 * di catalogo è inglese mentre il ripiego `t(…)` resta italiano, quindi i tre
 * modi di sbagliare si distinguono l'uno dall'altro a schermo.
 *
 * Cade se qualcuno rimette `j.error` davanti (comparirebbe la prosa italiana del
 * server), cade se chiama `messaggioDaCorpo` e ne butta via il ritorno
 * (comparirebbe il ripiego italiano), cade se la chiave sparisce dal catalogo
 * inglese (si ricadrebbe sulla prosa del server).
 */

/** La prosa che il server manda accanto al codice: italiana per costruzione. */
const PROSA_DEL_SERVER = 'Sede non accessibile';

function rispostaCassaCategorie(corpoErrore: Record<string, unknown>, stato = 403) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    // GET iniziale: nessuna categoria, ambiente disponibile.
    if (!init || (init.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ disponibile: true, categorie: [] }) };
    }
    if (u.includes('/api/pagamenti/cassa/categorie')) {
      return { ok: stato < 400, status: stato, json: async () => corpoErrore };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

async function aggiungiCategoria() {
  render(<CassaCategorieManager userId="u1" scuolaId="s1" />);
  const campo = await screen.findByRole('textbox');
  fireEvent.change(campo, { target: { value: 'Cancelleria' } });
  fireEvent.click(screen.getByRole('button', { name: itContabilita.cassaCatAggiungi }));
}

describe('cockpit — il rifiuto del server si legge nella lingua dell’interfaccia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('lang', 'it');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.setAttribute('lang', 'it');
    cleanup();
  });

  it('con lang="en" mostra ESATTAMENTE la frase inglese di catalogo, non la prosa italiana', async () => {
    document.documentElement.setAttribute('lang', 'en');
    vi.stubGlobal(
      'fetch',
      rispostaCassaCategorie({ error: PROSA_DEL_SERVER, codice: 'SEDE_NON_ACCESSIBILE' }),
    );

    await aggiungiCategoria();

    const atteso = en.erroreSedeNonAccessibile;
    await waitFor(() => expect(screen.getByText(atteso)).toBeInTheDocument());

    // La misura che conta: NIENTE italiano a schermo. «Sede» è la sottostringa
    // che comparirebbe sia rimettendo `j.error` sia perdendo la chiave inglese.
    expect(document.body.textContent).not.toContain('Sede');
    // E nemmeno il ripiego italiano del componente, che è il segno di una
    // chiamata a `messaggioDaCorpo` il cui ritorno è stato buttato via.
    expect(screen.queryByText(itContabilita.cassaCatErrAggiungi)).toBeNull();
  });

  it('con lang="it" la stessa risposta mostra la frase ITALIANA di catalogo', async () => {
    vi.stubGlobal(
      'fetch',
      rispostaCassaCategorie({ error: PROSA_DEL_SERVER, codice: 'SEDE_NON_ACCESSIBILE' }),
    );

    await aggiungiCategoria();

    await waitFor(() => expect(screen.getByText(sharedIt.erroreSedeNonAccessibile)).toBeInTheDocument());
    expect(screen.queryByText(en.erroreSedeNonAccessibile)).toBeNull();
  });

  it('SENZA codice la prosa del cockpit resta: il rifiuto non diventa una frase generica', async () => {
    // Il cockpit non è una schermata di famiglia: quando il server non dichiara
    // un codice, il motivo che ha scritto per chi opera è l'unica informazione
    // utile e va mostrato. Un componente passato a `soloCatalogoDaCorpo` per
    // errore lo perderebbe, e questo test se ne accorge.
    document.documentElement.setAttribute('lang', 'en');
    vi.stubGlobal(
      'fetch',
      rispostaCassaCategorie({ error: 'Alcune classi destinatarie non appartengono alla sede' }),
    );

    await aggiungiCategoria();

    await waitFor(() =>
      expect(
        screen.getByText('Alcune classi destinatarie non appartengono alla sede'),
      ).toBeInTheDocument(),
    );
  });
});

/**
 * `fetch` per i due casi di `FatturaButton`: l'ANTEPRIMA riesce, la POST fallisce.
 *
 * ⚠️ Dal 2026-09-04 il modale «Emetti» non emette alla cieca: chiede prima
 * `/api/pagamenti/fattura/anteprima` — cioè lo stesso codice che compone la causale
 * dell'emissione — e finché non ha una risposta il pulsante resta disabilitato. Un
 * `fetch` stubbato che fallisce per TUTTO non arriverebbe mai alla POST, e questi due
 * casi misurerebbero il blocco invece della traduzione del rifiuto.
 */
function fetchConAnteprima(rispostaPost: { ok: boolean; status: number; corpo: unknown }) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/anteprima')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { causale: 'Retta — anteprima', origine: 'categoria', lunghezza: 18, limite: 200, eccede: false },
        }),
      };
    }
    return { ok: rispostaPost.ok, status: rispostaPost.status, json: async () => rispostaPost.corpo };
  });
}

describe('cockpit — un rifiuto senza `error` non mostra la stringa «undefined»', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('lang', 'it');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('FatturaButton: il 500 con corpo vuoto porta la frase di ripiego, non «undefined»', async () => {
    const avvisi: string[] = [];
    vi.stubGlobal('alert', vi.fn((m: string) => { avvisi.push(m); }));
    vi.stubGlobal('fetch', fetchConAnteprima({ ok: false, status: 500, corpo: {} }));

    render(<FatturaButton pagamentoId="p1" userId="u1" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContabilita.fatBtn_invia) }));
    const emetti = await screen.findByRole('button', { name: new RegExp(itContabilita.fatBtn_emetti) });
    await waitFor(() => expect((emetti as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(emetti);

    await waitFor(() => expect(avvisi).toHaveLength(1));
    // Il difetto era letterale: `alert(j.error)` con `error` assente stampava
    // la parola «undefined» a una segretaria.
    // `String(...)` di proposito: col difetto rimesso, `alert(j.error)` passa
    // `undefined` — e un `toContain` su `undefined` fallirebbe con un errore di
    // tipo invece che con la misura. Così il rosso dice cosa è andato storto.
    expect(String(avvisi[0])).not.toContain('undefined');
    expect(avvisi[0]).toBe(itContabilita.fatBtn_err_emissione);
  });

  it('FatturaButton: con un codice dichiarato e lang="en" l’avviso è in inglese', async () => {
    document.documentElement.setAttribute('lang', 'en');
    const avvisi: string[] = [];
    vi.stubGlobal('alert', vi.fn((m: string) => { avvisi.push(m); }));
    vi.stubGlobal(
      'fetch',
      fetchConAnteprima({ ok: false, status: 403, corpo: { error: PROSA_DEL_SERVER, codice: 'SEDE_NON_ACCESSIBILE' } }),
    );

    render(<FatturaButton pagamentoId="p1" userId="u1" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itContabilita.fatBtn_invia) }));
    const emetti = await screen.findByRole('button', { name: new RegExp(itContabilita.fatBtn_emetti) });
    await waitFor(() => expect((emetti as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(emetti);

    await waitFor(() => expect(avvisi).toHaveLength(1));
    expect(avvisi[0]).toBe(en.erroreSedeNonAccessibile);
    expect(avvisi[0]).not.toContain('Sede');
  });
});
