import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "react";
import OfflinePage from "@/app/offline/page";

/**
 * La pagina `/offline` IDRATATA DAVVERO.
 *
 * ─── IL DIFETTO CHE QUESTO FILE DIFENDE ────────────────────────────────────
 * Misurato in produzione sull'emulatore Android, con un MutationObserver
 * installato PRIMA del caricamento del documento (CDP
 * `Page.addScriptToEvaluateOnNewDocument`):
 *
 *   t=  33ms  DOMContentLoaded   hidden=true   voci=0
 *   t= 134ms  mutazione          hidden=false  voci=2   ← lo script inline FUNZIONA
 *   t= 151ms  load               hidden=false  voci=2
 *   t= 500ms  tick               hidden=true   voci=0   ← ANNULLATO
 *   t=1000…8500ms                hidden=true   voci=0   (resta annullato)
 *
 * Lo script inline trovava `/auth/login` e `/parent` in cache e disegnava
 * l'elenco; poi React idratava, trovava un DOM diverso da quello che aveva
 * reso il server (un `<ul>` con due `<li>` dentro dove lui ne aveva reso zero),
 * ricostruiva il sottoalbero — e riportava tutto allo stato del server. Quello
 * che restava all'utente era l'elenco nascosto E il paragrafo «su questo
 * dispositivo non c'è ancora nessuna pagina salvata da consultare»: la variante
 * SBAGLIATA, perché le pagine c'erano.
 *
 * ─── PERCHÉ I 21 TEST DELLA PAGINA NON L'HANNO VISTO ───────────────────────
 * `__tests__/offline/pagina-offline.test.tsx` esegue lo script inline su markup
 * statico dentro un contesto `vm`: niente React, niente idratazione. Provava
 * (correttamente) che lo script fa il suo lavoro, e non poteva vedere chi
 * gliolo disfaceva subito dopo. Questo file monta l'ALTRA metà: idrata con
 * `hydrateRoot` e guarda cosa resta.
 */

/**
 * L'origine di jsdom, NON `https://app.kidville.it`: sia lo script inline sia il
 * componente client scartano le chiavi di cache cross-origin (giustamente: la
 * CacheStorage contiene anche risposte di terze parti). Con un'origine finta
 * diversa da quella della finestra, l'elenco resterebbe vuoto per il motivo
 * sbagliato e il test sarebbe verde a vuoto.
 */
const ORIGIN = window.location.origin;

let root: Root | null = null;

/**
 * Errori di idratazione RECUPERABILI, raccolti invece che lasciati esplodere.
 *
 * Sono attesi, e vale la pena dire perché. Quando lo script inline ha già
 * disegnato l'elenco, React trova nel DOM dei `<li>` che il server non aveva
 * reso: qualunque NODO aggiunto prima dell'idratazione produce un mismatch —
 * i soli attributi no, i nodi sì. Non è evitabile senza rinunciare allo script
 * inline (che è l'unico soccorso quando il bundle non c'è) o senza ritardarlo
 * (cioè rallentare proprio il caso in cui è l'unica cosa che funziona).
 *
 * Il contratto quindi NON è «nessun mismatch»: è «qualunque cosa faccia React,
 * il DOM finale è corretto». React ricostruisce dal server e subito dopo
 * l'effetto del componente client ridisegna dallo stato — ed è ciò che questi
 * test verificano.
 */
let recuperati: unknown[] = [];

/** Cache finta: `caches.keys()` + `caches.open(nome).keys()`, come nel browser. */
function cacheFinta(mappa: Record<string, string[]>) {
  return {
    keys: async () => Object.keys(mappa),
    open: async (nome: string) => ({
      keys: async () => (mappa[nome] ?? []).map((u) => ({ url: u })),
    }),
  };
}

/**
 * Riproduce la sequenza REALE del browser:
 *  1. il documento (markup del server) è nel DOM;
 *  2. gli script inline partono subito e disegnano;
 *  3. più tardi arriva il bundle e React idrata.
 */
async function montaEIdrata(cookie?: string) {
  if (cookie) document.cookie = cookie;

  document.body.innerHTML = renderToString(<OfflinePage />);

  // 2. gli script inline, eseguiti nel contesto GLOBALE di jsdom (non in una
  // `vm` isolata): devono vedere lo stesso `document` che React idraterà.
  for (const s of Array.from(document.querySelectorAll("script"))) {
    new Function(s.textContent ?? "")();
  }
  await new Promise((r) => setTimeout(r, 0));

  // 3. l'idratazione.
  await act(async () => {
    root = hydrateRoot(document.body, <OfflinePage />, {
      onRecoverableError: (e) => recuperati.push(e),
    });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Stato del DOM PRIMA dell'idratazione: serve a provare che lo script inline fa il suo lavoro. */
function preIdratazione(): { voci: number; disponibiliVisibile: boolean } {
  return {
    voci: document.querySelectorAll('[data-kv-elenco="it"] a').length,
    disponibiliVisibile: !(
      document.querySelector("[data-kv-disponibili]") as HTMLElement
    ).hidden,
  };
}

function voci(lingua: "it" | "en" = "it"): string[] {
  return Array.from(
    document.querySelectorAll(`[data-kv-elenco="${lingua}"] a`)
  ).map((a) => a.getAttribute("href") ?? "");
}

function visibile(selettore: string): boolean {
  const n = document.querySelector(selettore) as HTMLElement | null;
  if (!n) throw new Error(`selettore assente dal markup: ${selettore}`);
  return !n.hidden;
}

beforeEach(() => {
  // Senza questo React avvisa «testing environment is not configured to
  // support act(...)» e gli effetti passivi non vengono drenati in modo
  // deterministico: il test misurerebbe il tempismo, non il comportamento.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
    true;
  document.cookie = "KV_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.documentElement.lang = "it";
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
  document.body.innerHTML = "";
});

describe("pagina /offline — sopravvive all’idratazione di React", () => {
  it("l’elenco delle pagine in cache è ANCORA lì dopo l’idratazione", async () => {
    vi.stubGlobal(
      "caches",
      cacheFinta({
        "kidville-shell-v3": [`${ORIGIN}/auth/login`, `${ORIGIN}/parent`],
      })
    );

    await montaEIdrata();

    expect(voci()).toEqual(["/auth/login", "/parent"]);
    expect(visibile("[data-kv-disponibili]")).toBe(true);
  });

  it("lo script inline disegna PRIMA, e l’idratazione non lo cancella: la sequenza del device", async () => {
    // Ricostruisce la storia registrata sull'emulatore: t=134ms lo script
    // disegna, t=500ms era tutto sparito. Le due asserzioni sono entrambe
    // necessarie — la prima prova che lo script funziona (se un domani
    // smettesse, la seconda passerebbe lo stesso grazie a React e nessuno
    // saprebbe che il ripiego senza-bundle è morto).
    vi.stubGlobal(
      "caches",
      cacheFinta({ "kidville-shell-v3": [`${ORIGIN}/parent`] })
    );

    document.body.innerHTML = renderToString(<OfflinePage />);
    for (const s of Array.from(document.querySelectorAll("script"))) {
      new Function(s.textContent ?? "")();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(preIdratazione()).toEqual({ voci: 1, disponibiliVisibile: true });

    await act(async () => {
      root = hydrateRoot(document.body, <OfflinePage />, {
        onRecoverableError: (e) => recuperati.push(e),
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(voci()).toEqual(["/parent"]);
    expect(visibile("[data-kv-disponibili]")).toBe(true);
  });

  it("dopo l’idratazione resta il paragrafo GIUSTO: la promessa si può mantenere", async () => {
    vi.stubGlobal(
      "caches",
      cacheFinta({ "kidville-shell-v3": [`${ORIGIN}/parent`] })
    );

    await montaEIdrata();

    expect(visibile('[data-kv-corpo="cache"]')).toBe(true);
    expect(visibile('[data-kv-corpo="vuota"]')).toBe(false);
  });

  it("senza nulla in cache l’idratazione lascia la variante senza promessa", async () => {
    vi.stubGlobal(
      "caches",
      cacheFinta({ "kidville-shell-v3": [`${ORIGIN}/offline`] })
    );

    await montaEIdrata();

    expect(voci()).toEqual([]);
    expect(visibile("[data-kv-disponibili]")).toBe(false);
    expect(visibile('[data-kv-corpo="cache"]')).toBe(false);
    expect(visibile('[data-kv-corpo="vuota"]')).toBe(true);
  });

  it("la lingua scelta dal genitore sopravvive all’idratazione", async () => {
    // Stesso difetto, seconda vittima: SCRIPT_LINGUA nasconde i blocchi IT e
    // mostra quelli EN toccando `hidden` fuori da React. Se l'idratazione lo
    // annulla, un genitore che ha scelto l'inglese si ritrova la pagina in
    // italiano — o, peggio, entrambe le lingue una sotto l'altra.
    vi.stubGlobal(
      "caches",
      cacheFinta({ "kidville-shell-v3": [`${ORIGIN}/parent`] })
    );

    await montaEIdrata("KV_LOCALE=en; path=/");

    const blocchi = Array.from(
      document.querySelectorAll("[data-kv-lang]")
    ) as HTMLElement[];
    const visibili = blocchi
      .filter((b) => !b.hidden)
      .map((b) => b.getAttribute("data-kv-lang"));
    expect(visibili).toEqual(["en"]);
    expect(document.documentElement.lang).toBe("en");
    // L'elenco è tradotto nella lingua giusta anche dopo l'idratazione.
    expect(
      Array.from(document.querySelectorAll('[data-kv-elenco="en"] a')).map(
        (a) => a.textContent
      )
    ).toEqual(["Family home"]);
  });
});
