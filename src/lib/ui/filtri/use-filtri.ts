'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  azzeraFiltro,
  contaAttivi,
  descriviAttivi,
  filtraRighe,
  parametriGovernati,
  pulisciFiltri,
  queryServer,
  valoriIniziali,
  versoUrl,
} from './motore';
import type { CampoFiltro, FiltroAttivo, ValoreFiltro, ValoriFiltri } from './tipi';

/**
 * ─── LO STATO DELLA BARRA FILTRI ─────────────────────────────────────────────
 *
 * Tre vincoli, e ognuno è già stato pagato in questo repo.
 *
 * ── 1. SI ESPONE UNA STRINGA, NON UN `URLSearchParams` ──────────────────────
 * `chiaveServer` è una STRINGA stabile. Un `URLSearchParams` è un oggetto nuovo
 * a ogni render: metterlo nelle dipendenze di un `useEffect` che ricarica i dati
 * significa ricaricare a ogni render, cioè un ciclo di fetch infinito che si
 * presenta come «la pagina è lenta». È la stessa ragione per cui
 * `src/lib/context/sede-context.tsx` espone `reFetchKey` come stringa
 * (`effettive.join(',')`) e non come array.
 *
 *     useEffect(() => { ricarica() }, [chiaveServer])   // ← così si usa
 *
 * ── 2. L'URL SI SCRIVE CON `history.replaceState`, MAI CON `router.replace` ──
 * `router.replace` di Next fa un round-trip RSC: a ogni battuta di tasto la
 * pagina interroga il server per riavere se stessa. `replaceState` cambia la
 * barra degli indirizzi e basta — che è tutto ciò che serve, perché lo stato
 * vive già in React. La lettura iniziale avviene UNA VOLTA SOLA, dentro
 * l'inizializzatore pigro di `useState`: rileggere `useSearchParams()` a ogni
 * render riporterebbe indietro ciò che l'utente sta scrivendo.
 *
 * I parametri ALTRUI non si toccano: si cancellano e riscrivono soltanto quelli
 * governati da questi campi. In questa applicazione la query porta quasi sempre
 * un `?userId=`, e riscriverla per intero scollegherebbe la pagina dall'utente.
 *
 * ── 3. NESSUN `setState` DENTRO UN EFFETTO ──────────────────────────────────
 * `react-hooks/set-state-in-effect` è un ERRORE nel gate di questo repo, non un
 * warning. Il debounce parte dal GESTORE D'EVENTO con `setTimeout`; gli effetti
 * qui dentro non chiamano `setState`: uno tiene aggiornata la chiusura dello
 * smontaggio, l'altro è solo un cleanup (azzera il timer e ripulisce l'URL).
 *
 * ── IL DEBOUNCE, e a chi si applica ─────────────────────────────────────────
 * Solo ai campi `dove: 'server'`, perché solo loro fanno partire una richiesta:
 * 300 ms, così una parola digitata non diventa otto fetch. I campi `client`
 * filtrano SUBITO — le righe sono già in memoria e aspettare sarebbe solo
 * lentezza inventata. Togliere un chip e «Pulisci filtri» non aspettano
 * nemmeno: sono gesti unici e deliberati, non una raffica.
 *
 * ⚠️ `useSearchParams()` chiede un confine `<Suspense>` sopra la pagina che monta
 * questo hook (vale per tutto l'App Router, non per questo hook in particolare):
 * le pagine del cockpit lo hanno già — vedi `admin/protocolli/page.tsx`.
 */

export interface StatoFiltri<R> {
  /** Lo stato corrente, chiave del campo → valore. */
  valori: ValoriFiltri;
  /** Cambia un campo. Sui campi server fa partire il debounce. */
  imposta: (chiave: string, valore: ValoreFiltro) => void;
  /** Toglie un filtro (o, con `valore`, una sola scelta di un `multi`). Subito. */
  rimuovi: (chiave: string, valore?: string) => void;
  /**
   * «Pulisci filtri»: azzera tutto TRANNE gli obbligatori, che restano dove sono.
   * Solo stato: il fuoco lo rimette a posto chi possiede il campo (vedi la nota
   * subito dopo questa interfaccia).
   */
  pulisci: () => void;
  /**
   * La query per l'API, come STRINGA stabile e già attesa (debounced).
   * È il valore da mettere nelle dipendenze dell'effetto che ricarica.
   */
  chiaveServer: string;
  /**
   * C'è una richiesta che sta per partire. Serve a tenere le righe precedenti a
   * schermo attenuate (`opacity-60 pointer-events-none` + `aria-busy`) invece di
   * sostituirle con uno spinner: sparire a ogni tasto è il difetto peggiore che
   * una barra filtri possa avere.
   */
  inAttesa: boolean;
  /** I filtri attivi, pronti a diventare chip removibili. */
  attivi: FiltroAttivo[];
  /** Quanti filtri l'utente ha aggiunto (gli obbligatori non contano). */
  nAttivi: number;
  /** Le righe che passano i filtri CLIENT. I server hanno già filtrato loro. */
  filtra: (righe: readonly R[]) => R[];
}

/**
 * ⚠️ QUI NON C'È NESSUN `ricercaRef`, ED È UNA MISURA, NON UNA DIMENTICANZA.
 *
 * Il piano chiedeva che l'hook esponesse il ref del campo di ricerca per
 * restituirgli il fuoco dopo «Pulisci filtri» (WCAG 2.4.3). Non si può, in
 * questo repo: la regola `react-hooks/refs` del compilatore React — che qui è
 * ERRORE, non warning — marca come «ref» qualunque valore finisca in un
 * `ref={…}`, e la marcatura RISALE all'oggetto da cui è stato preso. Misurato:
 * con `<input ref={stato.ricercaRef}>` ogni successivo `stato.nAttivi`,
 * `stato.attivi.map(…)` e `stato.pulisci` letto durante il render della barra
 * diventava un errore di gate — **otto**. Cambiare il ref in una callback ref
 * non è bastato: la marcatura viene dall'uso in `ref=`, non dal tipo.
 *
 * Il comportamento però NON si perde: il fuoco lo restituisce chi possiede il
 * campo, cioè `BarraFiltri`, che ha il proprio ref locale e lo rimette a posto
 * subito dopo `pulisci()`. È anche il posto giusto — l'hook non tocca il DOM —
 * ed è misurato end-to-end in `__tests__/components/barra-filtri.test.tsx` §7.
 */

const DEBOUNCE_PREDEFINITO_MS = 300;

/** Riscrive SOLO i parametri governati, lasciando in pace tutti gli altri. */
function scriviIndirizzo(governati: readonly string[], nuovi: URLSearchParams): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const nome of governati) url.searchParams.delete(nome);
  for (const [nome, valore] of nuovi) url.searchParams.set(nome, valore);
  const query = url.searchParams.toString();
  window.history.replaceState(window.history.state, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`);
}

export function useFiltri<R>(
  campi: readonly CampoFiltro<R>[],
  opzioni?: { debounceMs?: number; scriviUrl?: boolean },
): StatoFiltri<R> {
  const debounceMs = opzioni?.debounceMs ?? DEBOUNCE_PREDEFINITO_MS;
  const scriviUrl = opzioni?.scriviUrl ?? true;

  // Letto UNA volta sola, nell'inizializzatore pigro: da qui in poi la verità è
  // lo stato di React, e l'indirizzo la insegue (non il contrario).
  const parametriIniziali = useSearchParams();
  const [valori, setValori] = useState<ValoriFiltri>(() => valoriIniziali(campi, parametriIniziali));
  const [chiaveServer, setChiaveServer] = useState<string>(() => queryServer(campi, valori).toString());
  const [inAttesa, setInAttesa] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const percorsoRef = useRef<string | null>(null);
  const smontaggioRef = useRef<() => void>(() => {});

  /**
   * Il cuore: aggiorna i valori, riscrive l'indirizzo e — se la query per l'API
   * è cambiata davvero — programma (o applica) la nuova `chiaveServer`.
   *
   * `subito` distingue il gesto unico (togliere un chip, pulire, scegliere da un
   * elenco a discesa) dalla raffica (la digitazione). Si chiama SEMPRE da un
   * gestore d'evento: qui non c'è nessun effetto.
   */
  const applica = (nuovi: ValoriFiltri, subito: boolean) => {
    setValori(nuovi);
    if (scriviUrl) scriviIndirizzo(parametriGovernati(campi), versoUrl(campi, nuovi));

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const nuovaChiave = queryServer(campi, nuovi).toString();
    if (nuovaChiave === chiaveServer) {
      // Niente da chiedere all'API: o è cambiato un filtro client, o si è
      // tornati esattamente a com'era (e allora l'attesa in corso va annullata,
      // non lasciata scadere su una richiesta che non serve più).
      setInAttesa(false);
      return;
    }
    if (subito || debounceMs <= 0) {
      setChiaveServer(nuovaChiave);
      setInAttesa(false);
      return;
    }
    setInAttesa(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setChiaveServer(nuovaChiave);
      setInAttesa(false);
    }, debounceMs);
  };

  const imposta = (chiave: string, valore: ValoreFiltro) => {
    const campo = campi.find((c) => c.chiave === chiave);
    applica({ ...valori, [chiave]: valore }, campo?.dove !== 'server');
  };

  const rimuovi = (chiave: string, valore?: string) => {
    applica(azzeraFiltro(campi, valori, chiave, valore), true);
  };

  // Solo stato: il fuoco lo rimette a posto chi possiede il campo (vedi la nota
  // sotto `StatoFiltri`). Un hook che tocca il DOM è un hook che non si può
  // provare senza montarlo.
  const pulisci = () => applica(pulisciFiltri(campi, valori), true);

  // Unico effetto CON un corpo, e non contiene nessun `setState`: tiene
  // aggiornata la chiusura che verrà eseguita allo smontaggio, e registra al
  // primo giro il percorso su cui questa barra vive.
  useEffect(() => {
    if (percorsoRef.current === null) percorsoRef.current = window.location.pathname;
    smontaggioRef.current = () => {
      if (!scriviUrl) return;
      // Solo sul PROPRIO percorso: durante una navigazione lo smontaggio arriva
      // quando `window.location` è già la pagina NUOVA, e ripulire lì
      // cancellerebbe i parametri di qualcun altro che si chiamano uguale.
      if (window.location.pathname !== percorsoRef.current) return;
      scriviIndirizzo(parametriGovernati(campi), new URLSearchParams());
    };
  });

  // Solo cleanup: il timer non deve sopravvivere al componente (scriverebbe uno
  // stato smontato) e l'indirizzo non deve restare pieno di filtri di una
  // schermata che non c'è più.
  useEffect(() => {
    const timer = timerRef;
    const smontaggio = smontaggioRef;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      smontaggio.current();
    };
  }, []);

  return {
    valori,
    imposta,
    rimuovi,
    pulisci,
    chiaveServer,
    inAttesa,
    attivi: descriviAttivi(campi, valori),
    nAttivi: contaAttivi(campi, valori),
    filtra: (righe) => filtraRighe(campi, valori, righe),
  };
}
