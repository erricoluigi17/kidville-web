import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import OfflinePage from '@/app/offline/page';
import { ATTESA_REACT_MS } from '@/app/offline/script-offline';

/**
 * `/offline` — ZERO errori di idratazione con la cache già popolata.
 *
 * ─── IL DIFETTO CHE QUESTO FILE DIFENDE ────────────────────────────────────
 * Misurato in collaudo (2026-08-02, Chrome su localhost:3100): aprendo
 * `/offline` con qualche rotta già in CacheStorage la console riporta
 *   «Minified React error #418» — *Hydration failed because the server rendered
 *   HTML didn't match the client. As a result this tree will be regenerated on
 *   the client*
 * a ogni caricamento (a intermittenza: è una CORSA fra la risposta della
 * CacheStorage e l'idratazione). La pagina, a occhio, è corretta — ed è il
 * motivo per cui è rimasta così: React scarta l'HTML del server e ricostruisce
 * l'INTERO albero, il che su questa pagina si vede solo in console.
 *
 * CAUSA RADICE: lo script inline appendeva i propri `<li data-kv-inline>` (e
 * ribaltava gli `hidden` delle due varianti del paragrafo) PRIMA che React
 * idratasse. Misurato: il markup del server ha le due liste VUOTE, il DOM al
 * momento dell'idratazione ne ha 17-18 per lista. Qualunque NODO aggiunto prima
 * dell'idratazione è un mismatch.
 *
 * ─── PERCHÉ NON SI PUÒ SEMPLICEMENTE TOGLIERE LO SCRIPT INLINE ─────────────
 * Perché è l'unico che funziona quando il documento arriva dalla CacheStorage
 * SENZA il bundle di Next (app appena installata, nessuna rete: `precarica()`
 * salva `/offline`, non i suoi chunk). Lì React non idrata mai e l'elenco lo
 * disegna solo lui. Il commento in testa a `idratazione-offline.test.tsx` dava
 * per inevitabile il mismatch proprio per questo: ritardare lo script avrebbe
 * rallentato il caso in cui è l'unica cosa che funziona.
 *
 * ─── LA VIA D'USCITA: NON UN RITARDO CIECO, UNA DOMANDA ────────────────────
 * Il documento SA se il bundle esiste: se non c'è nessun `<script src="/_next/…">`
 * React non idraterà mai e lo script inline disegna SUBITO (nessun ritardo nel
 * caso che conta). Se invece il bundle c'è, si aspetta: o React dichiara il
 * possesso — e allora lo script inline non tocca niente e il mismatch non
 * esiste — oppure uno di quegli script FALLISCE (offline: i chunk non sono in
 * cache) e allora si disegna subito lo stesso. Il tetto d'attesa
 * (`ATTESA_REACT_MS`) è l'ultima rete, non il meccanismo principale.
 */

const ORIGIN = window.location.origin;
const ROTTE = ['/assistenza', '/privacy', '/termini'] as const;
const CHIAVI = { 'kidville-shell-v4': ROTTE.map((r) => `${ORIGIN}${r}`) };

let root: Root | null = null;
let recuperati: unknown[] = [];

function cacheImmediata(mappa: Record<string, string[]>) {
  return {
    keys: async () => Object.keys(mappa),
    open: async (nome: string) => ({
      keys: async () => (mappa[nome] ?? []).map((u) => ({ url: u })),
    }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Esegue gli script INLINE del documento (quelli con `src` non hanno corpo). */
function eseguiScriptInline() {
  for (const s of Array.from(document.querySelectorAll('script'))) {
    if (s.hasAttribute('src')) continue;
    new Function(s.textContent ?? '')();
  }
}

/**
 * Il bundle di Next, come sta nel documento vero: `<script src="/_next/…">` nel
 * `<head>`. NON nel body, che è il contenitore idratato: un nodo in più lì
 * sarebbe un mismatch causato dal test, non dal codice.
 */
function metteIlBundle(): HTMLScriptElement {
  const s = document.createElement('script');
  s.src = '/_next/static/chunks/main-app.js';
  document.head.appendChild(s);
  return s;
}

function voci(lingua: 'it' | 'en' = 'it'): string[] {
  return Array.from(document.querySelectorAll(`[data-kv-elenco="${lingua}"] a`)).map(
    (a) => a.getAttribute('href') ?? '',
  );
}

async function idrata() {
  await act(async () => {
    root = hydrateRoot(document.body, <OfflinePage />, {
      onRecoverableError: (e) => recuperati.push(e),
    });
  });
  await act(async () => {
    await tick();
  });
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'KV_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  document.documentElement.lang = 'it';
  document.head.innerHTML = '';
  recuperati = [];
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => {
      r.unmount();
    });
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('/offline — l\'idratazione non trova un DOM diverso da quello del server', () => {
  it('col bundle nel documento e la cache PIENA: nessun errore di idratazione', async () => {
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    metteIlBundle();
    eseguiScriptInline();
    // La CacheStorage ha già risposto: col difetto, qui le liste hanno 3 <li>
    // a testa e l'idratazione trova un DOM che il server non ha mai reso.
    await tick();
    await tick();
    expect(voci(), 'lo script inline non deve disegnare se il bundle sta arrivando').toEqual([]);

    await idrata();

    expect(recuperati, 'errori di idratazione recuperabili (React #418)').toEqual([]);
    // E l'elenco c'è lo stesso: lo disegna React, che è il suo turno.
    expect(voci()).toEqual([...ROTTE]);
    expect(voci('en')).toEqual([...ROTTE]);
  });

  it('CONTROLLO POSITIVO — senza bundle nel documento lo script inline disegna SUBITO', async () => {
    // È il caso per cui lo script esiste: documento dalla CacheStorage, nessun
    // chunk di Next, React non idraterà mai. Nessuna attesa, nemmeno un tick.
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline();
    await tick();

    expect(voci()).toEqual([...ROTTE]);
    expect((document.querySelector('[data-kv-disponibili]') as HTMLElement).hidden).toBe(false);
  });

  it('bundle presente ma che NON arriva: scaduta l\'attesa, disegna lo script inline', async () => {
    // Il documento è quello vero (i tag `<script src>` ci sono), ma i chunk non
    // sono in cache e la rete non c'è: React non idraterà mai. L'elenco non può
    // restare vuoto per sempre.
    vi.useFakeTimers();
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    metteIlBundle();
    eseguiScriptInline();

    await vi.advanceTimersByTimeAsync(0);
    expect(voci(), 'prima della scadenza si aspetta React').toEqual([]);

    await vi.advanceTimersByTimeAsync(ATTESA_REACT_MS + 50);
    expect(voci()).toEqual([...ROTTE]);
  });

  it('il bundle FALLISCE (offline): si disegna subito, senza aspettare la scadenza', async () => {
    // L'acceleratore: se un chunk di Next non si carica, l'idratazione non
    // avverrà — non c'è nulla da aspettare. È il caso REALE del documento
    // servito dalla CacheStorage, dove i tag ci sono ma le richieste falliscono.
    vi.useFakeTimers();
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    const script = metteIlBundle();
    eseguiScriptInline();
    await vi.advanceTimersByTimeAsync(0);
    expect(voci()).toEqual([]);

    script.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(10);

    expect(voci()).toEqual([...ROTTE]);
  });

  it('React ha già preso possesso: allo scadere dell\'attesa lo script inline NON tocca nulla', async () => {
    // La staffetta resta quella di prima: il possesso di React vince sempre,
    // anche quando la scadenza arriva dopo l'idratazione.
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    metteIlBundle();
    eseguiScriptInline();
    await idrata();

    // Oltre la scadenza: lo script inline si è svegliato e ha trovato React.
    await act(async () => {
      await new Promise((r) => setTimeout(r, ATTESA_REACT_MS + 50));
    });

    expect(voci()).toEqual([...ROTTE]);
    expect(document.querySelectorAll('[data-kv-elenco="it"] > li')).toHaveLength(ROTTE.length);
    expect(document.querySelectorAll('[data-kv-elenco] [data-kv-inline]')).toHaveLength(0);
  });
});
