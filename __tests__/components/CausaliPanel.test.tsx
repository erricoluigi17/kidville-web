import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CausaliPanel, CausaliFatturaPanel } from '@/components/features/admin/pagamenti/CausaliPanel';
import { DEFAULT_CAUSALE_TEMPLATE, PLACEHOLDER_CAUSALE } from '@/lib/pagamenti/causale';
import { LIMITE_CAUSALE_FATTURAPA } from '@/lib/pagamenti/causale-fattura';

/**
 * Il codice della voce COM'È SCRITTO NEL CATALOGO, non ricopiato qui: il chip `{codice}`
 * e l'anteprima devono mostrare lo stesso esempio, altrimenti il tooltip promette una
 * forma e la riga sotto ne fa vedere un'altra. È di sole lettere di proposito — questo
 * repository è pubblico e un esempio con una cifra dentro sarebbe un codice vero a tutti
 * gli effetti (v. il commento accanto al catalogo in `@/lib/pagamenti/causale`).
 */
const ESEMPIO_CODICE = PLACEHOLDER_CAUSALE.find((p) => p.chiave === 'codice')?.esempio ?? '';

// CF SINTETICO nell'anteprima (mai PII reale): coincide con l'esempio di
// PLACEHOLDER_CAUSALE. La sede è quella di produzione (nome pubblico, non PII).
type Patched = { causali_config?: Record<string, string> };

function mockFetch(patched: Patched[], causaliConfig: Record<string, string> = {}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/admin/settings/categorie')) {
      return { ok: true, json: async () => ({ success: true, data: [
        { id: 'c1', nome: 'Gita', slug: 'gita', icona: '🎒', is_sistema: false, ordine: 1 },
        { id: 'c2', nome: 'Mensa', slug: 'mensa', icona: '🍝', is_sistema: true, ordine: 2 },
      ] }) };
    }
    if (init?.method === 'PATCH' && u.startsWith('/api/admin/settings')) {
      patched.push(JSON.parse(String(init.body)) as Patched);
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    }
    if (u.startsWith('/api/admin/settings')) {
      return { ok: true, json: async () => ({ success: true, data: { causali_config: causaliConfig } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  });
}

describe('CausaliPanel — modelli di causale per categoria + predefinito', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mostra la riga «Predefinito» + una riga per categoria', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    // Predefinito precompilato col template storico
    await waitFor(() => expect(screen.getByLabelText('Predefinito')).toBeInTheDocument());
    expect((screen.getByLabelText('Predefinito') as HTMLInputElement).value).toBe(DEFAULT_CAUSALE_TEMPLATE);
    // una riga per ciascuna categoria (etichetta = nome, campo vuoto)
    expect(screen.getByLabelText(/Gita/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mensa/)).toBeInTheDocument();
    expect((screen.getByLabelText(/Gita/) as HTMLInputElement).value).toBe('');
  });

  it('l\'anteprima dal vivo riflette il modello digitato', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Quota {descrizione}' } });
    // causaleBonifico(DATI_ESEMPIO_BONIFICO, «Quota {descrizione}») → «Quota Retta
    // Settembre 2026 #…»: il codice non è nel modello, lo aggiunge `conCodiceVoce` in
    // lettura. Il perché ha un test tutto suo, più sotto.
    await waitFor(() => expect(screen.getByText(`Quota Retta Settembre 2026 ${ESEMPIO_CODICE}`)).toBeInTheDocument());
  });

  it('un chip inserisce il segnaposto nel campo attivo', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.focus(campo);
    fireEvent.click(screen.getByRole('button', { name: /\{importo\}/ }));
    expect(campo.value).toContain('{importo}');
  });

  it('l\'anteprima non suggerisce il nome di una sede reale (né in chiaro né nei chip)', async () => {
    // R13. I dati d'esempio erano cablati su «Kidville Giugliano»: un admin di Aversa
    // che configurava le causali del SUO plesso vedeva l'anteprima finire con
    // «GIUGLIANO», e lo stesso nome usciva nel tooltip del chip {sede}. Con una sede
    // sola era un dettaglio; con tre è un suggerimento sbagliato, in una stringa che
    // il genitore poi ricopia nella causale del bonifico.
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    // Nessun plesso reale da nessuna parte: `innerHTML` copre anche gli attributi
    // (l'esempio del chip vive in un `title`, non nel testo).
    expect(document.body.innerHTML).not.toMatch(/giugliano|aversa|cesa/i);
    // …e al suo posto c'è un segnaposto neutro, sia nell'anteprima sia nel chip.
    expect(screen.getAllByText(/<SEDE>/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /\{sede\}/ }).getAttribute('title')).toContain('<SEDE>');
  });

  it('il salvataggio invia PATCH con causali_config (righe compilate)', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Quota {descrizione}' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva/ }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0].causali_config?.gita).toBe('Quota {descrizione}');
    // il predefinito resta il template storico (riga compilata → inviata)
    expect(patched[0].causali_config?.default).toBe(DEFAULT_CAUSALE_TEMPLATE);
    // categoria vuota (mensa) → INVIATA come '' così il server la strippa e la
    // chiave torna al Predefinito (svuotare = reset affidabile anche dopo un salvataggio).
    expect(patched[0].causali_config?.mensa).toBe('');
  });
});

/**
 * IL CODICE DELLA VOCE STA SUL BONIFICO E NON SULLA FATTURA, e i due editor lo dicono.
 *
 * L'editor è un componente solo, istanziato due volte: finché i due pannelli ricevevano
 * lo stesso catalogo di chip e lo stesso motore d'anteprima, la differenza fra i due
 * documenti non esisteva a schermo. Da quando la causale del bonifico porta il codice
 * della voce, quella simmetria è diventata due bugie opposte:
 *
 *  · nell'editor del BONIFICO l'anteprima resa con `renderCausale` non mostra il codice,
 *    mentre la causale che il genitore riceve ce l'ha (`causaleBonifico` → `conCodiceVoce`
 *    lo aggiunge anche ai modelli che non lo citano, cioè a quelli che le tre sedi hanno
 *    in archivio da prima che il codice esistesse);
 *  · nell'editor della FATTURA il chip `{codice}` è una promessa che a runtime rende
 *    **vuoto** — e `renderCausale` omette con grazia un segmento i cui segnaposto sono
 *    tutti vuoti, quindi chi lo mettesse in un segmento suo vedrebbe quel pezzo sparire
 *    da un documento fiscale senza un errore da nessuna parte.
 */
describe('CausaliPanel — l’anteprima dice quello che il documento dirà', () => {
  const patched: Patched[] = [];
  beforeEach(() => {
    patched.length = 0;
    vi.stubGlobal('fetch', mockFetch(patched));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('il catalogo espone un esempio di codice: senza, le asserzioni qui sotto sarebbero vuote', () => {
    // Controllo di sanità della MISURA, non del prodotto: con `ESEMPIO_CODICE` vuoto una
    // ricerca per «Retta Settembre 2026 ${ESEMPIO_CODICE}» sarebbe soddisfatta anche da
    // un'anteprima senza codice (il testo viene normalizzato e lo spazio in coda cade).
    expect(ESEMPIO_CODICE).toMatch(/^#[A-Z0-9]{7}$/);
  });

  it('il chip {codice} c’è nell’editor del BONIFICO e NON in quello della FATTURA', async () => {
    render(<><CausaliPanel userId="u1" scuolaId="sc-1" /><CausaliFatturaPanel userId="u1" scuolaId="sc-1" /></>);
    await waitFor(() => expect(screen.getAllByLabelText('Predefinito')).toHaveLength(2));
    const [bonifico, fattura] = screen.getAllByRole('region');
    expect(within(bonifico).getByRole('button', { name: /\{codice\}/ })).toBeInTheDocument();
    expect(within(fattura).queryByRole('button', { name: /\{codice\}/ })).toBeNull();
    // Controllo negativo: `{codice_fiscale}` c'è in TUTT'E DUE. Senza, l'assenza qui
    // sopra sarebbe verde anche per un pannello che non ha renderizzato nessun chip.
    expect(within(fattura).getByRole('button', { name: /\{codice_fiscale\}/ })).toBeInTheDocument();
    expect(within(bonifico).getByRole('button', { name: /\{codice_fiscale\}/ })).toBeInTheDocument();
  });

  it('l’anteprima del BONIFICO porta il codice anche per un modello che non lo cita', async () => {
    render(<CausaliPanel userId="u1" scuolaId="sc-1" />);
    const campo = (await screen.findByLabelText(/Gita/)) as HTMLInputElement;
    // Un modello «storico», della forma che le tre sedi hanno in archivio: `{codice}`
    // non compare da nessuna parte. È il caso per cui `conCodiceVoce` esiste.
    fireEvent.change(campo, { target: { value: '{descrizione} - {nome_completo}' } });
    // Stringa ESATTA: il codice è nel PRIMO segmento, attaccato alla descrizione, e mai
    // in coda — il campo causale dell'home banking si taglia da destra, e accodato il
    // codice sarebbe il primo pezzo a sparire proprio dalle causali più lunghe, cioè
    // quelle delle famiglie con più voci aperte.
    await waitFor(() => expect(
      screen.getByText(`Retta Settembre 2026 ${ESEMPIO_CODICE} - Mario Rossi`),
    ).toBeInTheDocument());
  });

  it('l’editor della FATTURA resta senza codice: né anteprima, né conteggio dei 200', async () => {
    // Se il pannello della fattura avesse ereditato il motore del bonifico, ogni modello
    // avrebbe guadagnato in silenzio il codice — otto caratteri su un campo che ne
    // ammette 200 — e il numero a schermo sarebbe diventato la misura di una stringa che
    // quel documento non porta.
    render(<CausaliFatturaPanel userId="u1" scuolaId="sc-1" />);
    await screen.findByLabelText('Predefinito');
    expect(screen.queryByText(new RegExp(ESEMPIO_CODICE))).toBeNull();
    const anteprima = screen.getAllByText(/a favore del minore Mario Rossi/)[0].textContent ?? '';
    expect(anteprima).not.toContain('#');
    // Il conteggio è la lunghezza di CIÒ CHE SI VEDE: una misura sola, come per il limite.
    expect(screen.getAllByText(`${anteprima.length}/${LIMITE_CAUSALE_FATTURAPA}`).length).toBeGreaterThan(0);
  });
});
