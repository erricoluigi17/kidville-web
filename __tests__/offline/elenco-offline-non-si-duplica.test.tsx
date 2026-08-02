import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import OfflinePage from '@/app/offline/page';
import { ATTRIBUTO_INLINE } from '@/app/offline/script-offline';

/**
 * `/offline` — l'elenco delle pagine consultabili NON si scrive due volte.
 *
 * ─── IL DIFETTO CHE QUESTO FILE DIFENDE ────────────────────────────────────
 * Misurato in produzione (Chrome 390×844, 5 volte su 5) con `/assistenza`,
 * `/privacy` e `/termini` in cache: sotto «PAGINE GIÀ APERTE, CONSULTABILI
 * ADESSO» comparivano SEI voci per TRE rotte — Assistenza, Privacy, Termini,
 * Assistenza, Privacy, Termini — e in console, a intermittenza, il React #418
 * (hydration failed).
 *
 * CAUSA RADICE: due implementazioni scrivono nello stesso `<ul data-kv-elenco>`.
 * Lo script inline (che è l'unico soccorso quando il documento arriva dalla
 * CacheStorage senza il bundle di Next) e il componente client, che dopo
 * l'idratazione rilegge la CacheStorage e rende i propri `<li>`. Non è la
 * stessa storia di `idratazione-offline.test.tsx`, è la sua metà mancante:
 * là lo script inline finiva PRIMA dell'idratazione e React ricostruiva il
 * sottoalbero (una copia sola, per fortuna); qui la lettura della CacheStorage
 * risponde DOPO — che è ciò che succede su un telefono lento — e allora lo
 * script inline inserisce i suoi `<li>` in una `<ul>` che React ormai possiede
 * e crede vuota. React non li vede, appende i propri: sei voci per tre rotte.
 *
 * ─── PERCHÉ I TEST ESISTENTI NON POTEVANO VEDERLO ──────────────────────────
 * `idratazione-offline.test.tsx` risolve la cache PRIMA di idratare
 * (`await new Promise(r => setTimeout(r, 0))` fra le due fasi): copre l'ordine
 * opposto, l'unico in cui il difetto non si manifesta. Qui la cache è
 * DIFFERITA di proposito, e la si sblocca a idratazione avvenuta.
 *
 * ─── IL CONTRATTO ──────────────────────────────────────────────────────────
 * Una sola implementazione possiede l'elenco in ogni istante, in QUALUNQUE
 * ordine arrivino le due risposte — e senza il bundle (React che non idrata
 * mai) lo script inline continua a fare tutto il lavoro. L'ultimo test di
 * questo file è il controllo positivo che vieta la scorciatoia «tolgo lo
 * script inline e il doppione sparisce»: sparirebbe anche la pagina, per chi
 * apre l'app senza rete la prima volta.
 */

/** L'origine di jsdom: le chiavi cross-origin vengono scartate da entrambe le implementazioni. */
const ORIGIN = window.location.origin;

const ROTTE = ['/assistenza', '/privacy', '/termini'] as const;

let root: Root | null = null;
let recuperati: unknown[] = [];

/**
 * CacheStorage finta la cui risposta arriva SOLO quando la si sblocca: è il
 * telefono lento, ed è la condizione in cui il difetto si manifesta.
 */
function cacheDifferita(mappa: Record<string, string[]>) {
  let apri!: () => void;
  const pronta = new Promise<void>((risolvi) => {
    apri = risolvi;
  });
  return {
    caches: {
      keys: async () => {
        await pronta;
        return Object.keys(mappa);
      },
      open: async (nome: string) => ({
        keys: async () => (mappa[nome] ?? []).map((u) => ({ url: u })),
      }),
    },
    sblocca: () => apri(),
  };
}

function cacheImmediata(mappa: Record<string, string[]>) {
  return {
    keys: async () => Object.keys(mappa),
    open: async (nome: string) => ({
      keys: async () => (mappa[nome] ?? []).map((u) => ({ url: u })),
    }),
  };
}

const CHIAVI = { 'kidville-shell-v4': ROTTE.map((r) => `${ORIGIN}${r}`) };

/** Un giro di macrotask: drena le catene di promise già registrate. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function eseguiScriptInline() {
  for (const s of Array.from(document.querySelectorAll('script'))) {
    new Function(s.textContent ?? '')();
  }
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
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('/offline — l’elenco non compare due volte', () => {
  it('cache che risponde DOPO l’idratazione: tre rotte, tre voci (non sei)', async () => {
    const { caches, sblocca } = cacheDifferita(CHIAVI);
    vi.stubGlobal('caches', caches);

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline(); // parte, ma la CacheStorage non ha ancora risposto
    await idrata(); // React idrata una <ul> vuota: nessun mismatch, la lista è sua

    sblocca();
    await act(async () => {
      await tick();
      await tick();
    });

    expect(voci()).toEqual([...ROTTE]);
    // Anche l'altra lingua: il documento contiene entrambe, e lo script inline
    // le riempiva tutte e due.
    expect(voci('en')).toEqual([...ROTTE]);
  });

  it('cache che risponde PRIMA dell’idratazione: resta una copia sola', async () => {
    // È l'ordine già coperto da `idratazione-offline.test.tsx`; sta qui perché
    // la staffetta non deve romperlo: ciò che lo script inline ha disegnato
    // prima dell'idratazione va rimosso, non sommato.
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline();
    await tick();
    expect(voci()).toEqual([...ROTTE]); // lo script inline ha fatto il suo lavoro

    await idrata();
    await act(async () => {
      await tick();
    });

    expect(voci()).toEqual([...ROTTE]);
  });

  it('ciò che disegna lo script inline è MARCATO: React deve poterlo riconoscere', async () => {
    // Il contratto fra i due file, e il motivo per cui esiste.
    //
    // Fermare lo script inline copre l'ordine in cui React arriva per primo.
    // Nell'ordine opposto React non può fermare nessuno: i `<li>` sono già nel
    // suo `<ul>`, e lui non sa di averne. Di solito l'idratazione se ne accorge
    // (nodi che il server non aveva reso) e ricostruisce il sottoalbero
    // buttandoli — di solito, non per contratto: fra il commit e l'esecuzione
    // degli effetti passa un turno di scheduler, e su un telefono lento la
    // CacheStorage può rispondere proprio lì, quando ricostruire non serve più.
    // Perciò React li rimuove esplicitamente, e per rimuoverli deve saper dire
    // quali sono suoi e quali no: è questo attributo a dirglielo.
    //
    // Quella finestra non è pilotabile in jsdom — non c'è un aggancio fra
    // commit ed effetti — quindi qui si verifica il contratto, non il tempismo:
    // ogni voce creata dallo script inline è marcata, e il selettore con cui
    // React le cerca le trova tutte.
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline();
    await tick();

    const voceIt = Array.from(document.querySelectorAll('[data-kv-elenco="it"] > li'));
    expect(voceIt).toHaveLength(ROTTE.length);
    expect(voceIt.every((li) => li.hasAttribute(ATTRIBUTO_INLINE))).toBe(true);
    // Il selettore è lo stesso che usa `ContenutoOffline`: se un domani i due
    // divergessero, la rimozione non troverebbe più nulla in silenzio.
    expect(
      document.querySelectorAll(`[data-kv-elenco] [${ATTRIBUTO_INLINE}]`),
    ).toHaveLength(ROTTE.length * 2); // due lingue, entrambe riempite
  });

  it('«Riprova» sonda la rete UNA volta sola, non due', async () => {
    // Stessa causa radice, altro nodo: sul link convivono il listener dello
    // script inline e l'onClick di React. Due sonde per un click sono due
    // richieste di rete su una pagina che esiste perché la rete non c'è.
    //
    // La cache è DIFFERITA per lo stesso motivo del primo test: se lo script
    // inline disegna prima dell'idratazione, React ricostruisce il sottoalbero
    // e il listener inline muore con il nodo che lo portava — il difetto
    // sparirebbe per un motivo che non c'entra, e il test sarebbe cieco.
    const { caches, sblocca } = cacheDifferita(CHIAVI);
    vi.stubGlobal('caches', caches);
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline();
    await idrata();
    sblocca();
    await act(async () => {
      await tick();
      await tick();
    });

    const link = document.querySelector('[data-kv-lang="it"] [data-kv-riprova]') as HTMLElement;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await tick();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('CONTROLLO POSITIVO — senza il bundle di Next l’elenco lo disegna lo script inline', async () => {
    // Il caso per cui lo script inline esiste: app appena installata, nessuna
    // rete, il documento arriva dalla CacheStorage e React non idrata MAI.
    // Se qualcuno "risolvesse" il doppione togliendo lo script, qui resterebbe
    // una pagina che promette pagine consultabili e non ne mostra nessuna.
    vi.stubGlobal('caches', cacheImmediata(CHIAVI));

    document.body.innerHTML = renderToString(<OfflinePage />);
    eseguiScriptInline();
    await tick();

    expect(voci()).toEqual([...ROTTE]);
    expect((document.querySelector('[data-kv-disponibili]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-kv-corpo="cache"]') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('[data-kv-corpo="vuota"]') as HTMLElement).hidden).toBe(true);
  });
});
