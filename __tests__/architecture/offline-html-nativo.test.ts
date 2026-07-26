import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock del ripiego NATIVO `mobile/www/offline.html`
 * (capacitor.config.ts → `server.errorPath`).
 *
 * Perché serve un test e non basta guardarla: questa pagina compare SOLO nel
 * caso che nessun Service Worker può coprire — app appena installata (o dati
 * cancellati) e dispositivo senza rete. È quindi il pezzo di app che si vede
 * più di rado e si prova quasi mai, ed è esattamente per questo che il difetto
 * ci è rimasto: il pulsante «Riprova» faceva `location.href='https://…'` alla
 * cieca. Senza rete quella navigazione fallisce, la WebView ricarica
 * `errorPath`, e l'utente resta inchiodato su un pulsante che non fa nulla e
 * non spiega niente.
 *
 * Vincolo che questi test difendono: si naviga SOLO dopo aver verificato che
 * l'host risponda; altrimenti si dice all'utente che la rete non c'è ancora.
 *
 * Nota sull'origine: la pagina è servita da `https://localhost` (schema locale
 * di Capacitor), quindi la sonda verso `app.kidville.it` è CROSS-ORIGIN e senza
 * CORS. L'unica risposta leggibile è quella opaca: `ok === false`, `status 0`.
 * Vale come «raggiungibile» il fatto stesso che la promise si risolva — un
 * `if (res.ok)` qui non navigherebbe MAI. Il test 「risposta opaca」 blinda
 * proprio questo.
 */

const PERCORSO = path.join(process.cwd(), 'mobile/www/offline.html');
const SORGENTE = fs.readFileSync(PERCORSO, 'utf8');
const URL_APP = 'https://app.kidville.it/';
const PARTENZA = 'https://localhost/offline.html';

const locationVera = window.location;

type LocationFinta = { href: string };

/** Monta il <body> del file nel jsdom ed esegue il suo script inline. */
function monta(lingua: string): LocationFinta {
  const corpo = SORGENTE.split('<body>')[1].split('</body>')[0];
  document.documentElement.lang = 'it';
  document.body.innerHTML = corpo.replace(/<script>[\s\S]*?<\/script>/g, '');

  Object.defineProperty(navigator, 'language', { value: lingua, configurable: true });

  const finta: LocationFinta = { href: PARTENZA };
  Object.defineProperty(window, 'location', { value: finta, writable: true, configurable: true });

  const script = /<script>([\s\S]*?)<\/script>/.exec(SORGENTE)?.[1] ?? '';
  expect(script.trim().length).toBeGreaterThan(0);
  new Function(script)();
  return finta;
}

function stato(): HTMLElement {
  const el = document.getElementById('kv-stato');
  if (!el) throw new Error('manca #kv-stato: la pagina non ha dove dire che la rete non c’è');
  return el;
}

function bottone(lingua: 'it' | 'en'): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button.${lingua}`);
  if (!el) throw new Error(`manca il pulsante .${lingua}`);
  return el;
}

/** Risposta opaca: è tutto ciò che una fetch `no-cors` può restituire. */
function rispostaOpaca(): Response {
  return { ok: false, status: 0, type: 'opaque' } as Response;
}

describe('ripiego nativo — la sonda prima della navigazione', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', {
      value: locationVera,
      writable: true,
      configurable: true,
    });
  });

  it('naviga solo dopo una HEAD andata a buon fine, e la HEAD ha un timeout', async () => {
    const chiamate: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', (u: string, o: RequestInit = {}) => {
      chiamate.push([u, o]);
      return Promise.resolve(rispostaOpaca());
    });

    const finta = monta('it-IT');
    expect(finta.href).toBe(PARTENZA);

    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));

    expect(chiamate).toHaveLength(1);
    const [url, opzioni] = chiamate[0];
    expect(url.startsWith(URL_APP)).toBe(true);
    expect(opzioni.method).toBe('HEAD');
    // Senza `no-cors` la fetch verso un'origine che non manda header CORS
    // fallisce SEMPRE, anche con la rete perfetta: la pagina non navigherebbe mai.
    expect(opzioni.mode).toBe('no-cors');
    expect(opzioni.cache).toBe('no-store');
    expect(opzioni.signal).toBeDefined();
  });

  it('una risposta OPACA vale come raggiungibile (ok=false, status 0)', async () => {
    // Prova di non-regressione contro l'errore più facile da commettere qui:
    // `if (res.ok) location.href = …`. Cross-origin `res.ok` è sempre false.
    vi.stubGlobal('fetch', () => Promise.resolve(rispostaOpaca()));
    const finta = monta('it-IT');
    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));
  });

  it('rete ancora assente: NON naviga e lo dice in italiano', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const finta = monta('it-IT');

    bottone('it').click();
    await vi.waitFor(() => expect(stato().textContent).toMatch(/Ancora nessuna connessione/i));

    expect(finta.href).toBe(PARTENZA);
  });

  it('rete ancora assente, sistema in inglese: «Still no connection»', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const finta = monta('en-US');

    expect(document.documentElement.lang).toBe('en');
    bottone('en').click();
    await vi.waitFor(() => expect(stato().textContent).toMatch(/Still no connection/i));

    expect(finta.href).toBe(PARTENZA);
  });

  it('la sonda che non risponde viene abortita: niente attesa infinita', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      (_u: string, o: RequestInit = {}) =>
        new Promise((_risolvi, rifiuta) => {
          o.signal?.addEventListener('abort', () =>
            rifiuta(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const finta = monta('it-IT');
    bottone('it').click();

    // Durante la sonda il pulsante è disabilitato: senza, due tocchi rapidi
    // fanno partire due sonde e la seconda naviga mentre la prima sta fallendo.
    expect(bottone('it').disabled).toBe(true);
    expect(stato().textContent).not.toMatch(/Ancora nessuna connessione/i);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(stato().textContent).toMatch(/Ancora nessuna connessione/i);
    expect(finta.href).toBe(PARTENZA);
    expect(bottone('it').disabled).toBe(false);
  });

  it('senza fetch (WebView antica) prova comunque a navigare: nessun vicolo cieco', async () => {
    vi.stubGlobal('fetch', undefined);
    const finta = monta('it-IT');
    bottone('it').click();
    await vi.waitFor(() => expect(finta.href).toBe(URL_APP));
  });
});

describe('ripiego nativo — lock del sorgente', () => {
  it('nessuna navigazione alla cieca appesa a onclick', () => {
    expect(SORGENTE).not.toMatch(/onclick\s*=\s*["'][^"']*location\.href/i);
  });

  it('nessuna dipendenza esterna: è il ripiego del ripiego', () => {
    // Un font, un CSS o un JS remoto qui sarebbero una richiesta di rete su una
    // pagina che esiste PROPRIO perché la rete non c'è.
    const url = SORGENTE.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    for (const u of url) expect(u.startsWith('https://app.kidville.it')).toBe(true);
    expect(SORGENTE).not.toMatch(/<link[^>]+href=/i);
    expect(SORGENTE).not.toMatch(/<script[^>]+src=/i);
  });

  it('resta bilingue: i due testi vivono entrambi nel documento', () => {
    expect(SORGENTE).toContain('class="it"');
    expect(SORGENTE).toContain('class="en"');
  });
});
