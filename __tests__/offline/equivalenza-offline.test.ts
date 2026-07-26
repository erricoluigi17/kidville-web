import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  costruisciScriptOffline,
  etichettaRotta,
  rotteDaChiaviCache,
  type DizionarioEtichette,
} from '@/app/offline/script-offline';
import testiIt from '../../messages/it/offline.json';
import testiEn from '../../messages/en/offline.json';

/**
 * Le DUE implementazioni della pagina `/offline` devono dire la stessa cosa.
 *
 * Sulla pagina offline convivono due modi di riempire l'elenco, e nessuno dei
 * due è di troppo:
 *  · lo script inline ES5 — l'unico che gira quando il documento arriva dalla
 *    CacheStorage senza il bundle di Next (app appena installata, niente rete:
 *    `precarica()` salva /offline, non i suoi chunk);
 *  · le funzioni TS di `script-offline.ts`, usate da `ContenutoOffline.tsx` —
 *    le uniche che valgono DOPO l'idratazione, perché da lì in poi il DOM lo
 *    possiede React e chi ci scrive da fuori viene disfatto.
 *
 * Il rischio di due implementazioni non è che esistano: è che DIVERGANO in
 * silenzio, e che il genitore veda un elenco diverso a seconda che il bundle
 * sia arrivato o no. Questo file le esegue sugli stessi ingressi e pretende lo
 * stesso risultato.
 */

const ORIGIN = 'https://app.kidville.it';

const DIZIONARI: Record<'it' | 'en', DizionarioEtichette> = {
  it: testiIt.etichette,
  en: testiEn.etichette,
};

/** Esegue lo script inline su un markup minimo: ciò che disegna si legge dal DOM. */
function eseguiScriptInline(chiavi: string[]): void {
  document.body.innerHTML =
    '<nav data-kv-disponibili hidden><ul data-kv-elenco="it"></ul>' +
    '<ul data-kv-elenco="en"></ul></nav>';

  const cacheFinta = {
    keys: async () => ['kidville-shell-v3'],
    open: async () => ({ keys: async () => chiavi.map((u) => ({ url: u })) }),
  };

  const contesto = vm.createContext({
    document,
    location: { origin: ORIGIN },
    caches: cacheFinta,
    fetch: () => Promise.reject(new TypeError('offline')),
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (t: unknown) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
    AbortController,
    Promise,
    URL,
    Date,
    Error,
    TypeError,
  });
  vm.runInContext(costruisciScriptOffline(DIZIONARI), contesto);
}

function leggi(lingua: 'it' | 'en'): { rotte: string[]; etichette: string[] } {
  const link = Array.from(document.querySelectorAll(`[data-kv-elenco="${lingua}"] a`));
  return {
    rotte: link.map((a) => a.getAttribute('href') ?? ''),
    etichette: link.map((a) => a.textContent ?? ''),
  };
}

/** Un tick: lo script inline lavora su promise. */
function attendi(): Promise<void> {
  return new Promise((r) => globalThis.setTimeout(r, 0));
}

function tramiteFunzioniTs(
  chiavi: string[],
  lingua: 'it' | 'en',
): { rotte: string[]; etichette: string[] } {
  const rotte = rotteDaChiaviCache(chiavi, ORIGIN);
  return { rotte, etichette: rotte.map((r) => etichettaRotta(DIZIONARI[lingua], r)) };
}

/**
 * I casi coprono ogni decisione che le due implementazioni prendono: filtri,
 * deduplicazione, ordinamento, query, etichette (esatta, per segmento,
 * derivata) e le due chiavi ostili che hanno già un test dedicato altrove.
 */
const CASI: Array<{ nome: string; chiavi: string[] }> = [
  { nome: 'vuoto', chiavi: [] },
  {
    nome: 'ordine e duplicati',
    chiavi: [`${ORIGIN}/parent/diary`, `${ORIGIN}/parent/avvisi`, `${ORIGIN}/parent/avvisi`],
  },
  {
    nome: 'filtri: /offline, /_next/, asset, altra origine',
    chiavi: [
      `${ORIGIN}/offline`,
      `${ORIGIN}/_next/static/chunks/a.js`,
      `${ORIGIN}/logo-kidville.png`,
      `${ORIGIN}/styles/app.css`,
      'https://cdn.esempio.it/parent/avvisi',
      `${ORIGIN}/parent/avvisi`,
    ],
  },
  { nome: 'query tagliata', chiavi: [`${ORIGIN}/parent/avvisi?userId=abc-123&next=%2F`] },
  {
    nome: 'etichette: esatta, per segmento, derivata',
    chiavi: [`${ORIGIN}/parent`, `${ORIGIN}/parent/mensa`, `${ORIGIN}/parent/qualcosa-di-nuovo`],
  },
  { nome: 'escape malformata', chiavi: [`${ORIGIN}/parent/%zz`, `${ORIGIN}/parent/avvisi`] },
  {
    nome: 'path ostile',
    chiavi: [`${ORIGIN}/parent/${encodeURIComponent('<img src=x>')}`],
  },
  { nome: 'chiave non-URL', chiavi: ['non-una-url', `${ORIGIN}/parent`] },
];

describe('pagina /offline — le due implementazioni non divergono', () => {
  for (const lingua of ['it', 'en'] as const) {
    for (const caso of CASI) {
      it(`${caso.nome} (${lingua}): script inline === funzioni TS`, async () => {
        eseguiScriptInline(caso.chiavi);
        await attendi();
        const inline = leggi(lingua);
        const ts = tramiteFunzioniTs(caso.chiavi, lingua);

        expect(
          inline,
          'lo script inline (senza bundle) e le funzioni TS (dopo l’idratazione) ' +
            'devono produrre lo stesso elenco: se divergono, il genitore vede pagine ' +
            'diverse a seconda che il bundle di Next sia arrivato o no.',
        ).toEqual(ts);
      });
    }
  }

  it('l’insieme dei casi non è vuoto e almeno uno produce rotte', () => {
    // Difesa contro il lock che si svuota: se `CASI` diventasse una lista di
    // insiemi tutti filtrati, ogni confronto sarebbe `[] === []`.
    const conRotte = CASI.filter((c) => tramiteFunzioniTs(c.chiavi, 'it').rotte.length > 0);
    expect(conRotte.length).toBeGreaterThanOrEqual(5);
  });
});
