'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  ATTRIBUTO_INLINE,
  ATTRIBUTO_POSSESSO,
  etichettaRotta,
  leggiRotteInCache,
  linguaDalCookie,
  sondaRete,
  type DizionarioEtichette,
} from './script-offline';

/**
 * Corpo della pagina `/offline`, con lo stato POSSEDUTO DA REACT.
 *
 * ─── PERCHÉ ESISTE QUESTO COMPONENTE ────────────────────────────────────────
 * Prima, l'elenco delle pagine in cache e la scelta della lingua li faceva solo
 * lo script inline, scrivendo nel DOM. Misurato in produzione sull'emulatore
 * Android con un MutationObserver installato prima del documento:
 *
 *   t= 134ms  lo script disegna l'elenco (2 voci, sezione visibile)
 *   t= 500ms  elenco sparito, sezione di nuovo nascosta — PER SEMPRE
 *
 * L'idratazione di React trovava un DOM diverso da quello reso dal server e lo
 * riportava allo stato del server, buttando via il lavoro dello script. Il
 * genitore restava con l'elenco nascosto e con il paragrafo «non c'è ancora
 * nessuna pagina salvata»: la variante sbagliata, perché le pagine c'erano.
 * Regola generale, non aneddoto: **su una pagina che React idrata, chi scrive
 * nel DOM da fuori perde**. L'unico modo di vincere è che sia React a sapere.
 *
 * ─── PERCHÉ LO SCRIPT INLINE RESTA ─────────────────────────────────────────
 * Non è ridondanza: è il codice che gira quando React non può girare. Fino al
 * 2026-08-03 qui c'era scritto che il Service Worker «salva la pagina, non il
 * suo bundle» — ed era esattamente il difetto T16-F1: `precarica()` metteva in
 * cache UN SOLO oggetto, il documento. Con 14 chunk su 15 già in cache (i
 * condivisi li scrive `assetStatico` navigando) React partiva, non trovava il
 * quindicesimo e l'error boundary si mangiava la pagina — «QUALCOSA È ANDATO
 * STORTO» al posto di «non sei in rete». Ora `precarica()` salva anche le
 * sotto-risorse `/_next/` del documento (`precaricaSottoRisorse` in
 * `public/sw.js`): mezzo bundle è peggio di nessun bundle.
 * Restano i casi in cui il bundle non c'è o è monco: pre-cache interrotto a
 * metà, `SHELL_MINIMA`, sviluppo (i chunk non sono immutabili e non si cachano),
 * un dispositivo col Service Worker vecchio. Quindi: lo script inline copre il
 * pre-idratazione e il senza-bundle, questo componente copre tutto il resto.
 * Le due implementazioni condividono le funzioni pure di `./script-offline` per
 * quanto è possibile, e `__tests__/offline/equivalenza-offline.test.ts` verifica
 * che diano lo stesso risultato sugli stessi ingressi.
 *
 * ─── PERCHÉ ESISTE UNA STAFFETTA, E NON SOLO DUE IMPLEMENTAZIONI ───────────
 * «Entrambe le implementazioni servono» non basta: serve dire QUANDO tocca a
 * chi. Senza quella regola, in produzione l'elenco è uscito DOPPIO — sei voci
 * per tre rotte — perché la CacheStorage ha risposto DOPO l'idratazione: React
 * aveva idratato una `<ul>` vuota e la considerava sua, lo script inline ci ha
 * infilato i propri `<li>`, React ha appeso i suoi senza vedere gli altri.
 * Da qui il primo effetto qui sotto: React DICHIARA il possesso su ogni lista
 * (`data-kv-owner="react"`) e butta ciò che lo script inline aveva disegnato
 * (`data-kv-inline`). Da quel momento lo script inline si astiene — vedi
 * `reactPossiede()` in `./script-offline.ts`. Difeso da
 * `__tests__/offline/elenco-offline-non-si-duplica.test.tsx`, che prova
 * ENTRAMBI gli ordini di arrivo e il caso senza bundle.
 *
 * ─── PERCHÉ IL PRIMO RENDER È IDENTICO A QUELLO DEL SERVER ─────────────────
 * `lingua: 'it'` e `rotte: []` non sono default pigri: sono ESATTAMENTE ciò che
 * rende il server. Leggere cookie o CacheStorage durante il render (o con
 * `useSyncExternalStore` senza snapshot server) produrrebbe un markup diverso e
 * un mismatch di idratazione — cioè il difetto di prima, per un'altra strada.
 * Si legge nell'effetto, dopo.
 */

export interface TestiOffline {
  titolo: string;
  corpo: string;
  corpoSenzaCache: string;
  riprova: string;
  nessunaRete: string;
  disponibili: string;
  nota: string;
  etichette: DizionarioEtichette;
}

const LINGUE = ['it', 'en'] as const;
type Lingua = (typeof LINGUE)[number];

const CLASSI_LINK =
  'block rounded-2xl bg-white/10 px-5 py-3 font-maven text-sm font-semibold text-white underline-offset-4 active:scale-95';

/** Nessuna sottoscrizione: il cookie della lingua non cambia mentre la pagina è aperta. */
const nonCambia = () => () => {};

export default function ContenutoOffline({ testi }: { testi: Record<Lingua, TestiOffline> }) {
  /**
   * Lingua: stessa fonte dello script inline (cookie `KV_LOCALE`), letta con
   * `useSyncExternalStore` e NON con `useState` + `useEffect`.
   *
   * Lo snapshot lato server è `'it'` — identico a ciò che rende il server, quindi
   * l'idratazione combacia — e subito dopo React rilegge lo snapshot del client.
   * È il modo previsto da React per leggere qualcosa che esiste solo nel browser
   * senza barare sul primo render (e senza il `setState` dentro l'effetto che
   * `react-hooks/set-state-in-effect` vieta, a ragione: sarebbe un render in più
   * su una pagina che deve essere leggerissima).
   */
  const lingua = useSyncExternalStore<Lingua>(
    nonCambia,
    () => linguaDalCookie(document.cookie),
    () => 'it',
  );
  const [rotte, setRotte] = useState<string[]>([]);
  const [nessunaRete, setNessunaRete] = useState(false);
  const [sondaInCorso, setSondaInCorso] = useState(false);

  // Il passaggio di consegne, prima di ogni altra cosa: da qui in avanti le
  // liste sono di React (l'attributo lo legge lo script inline, che si ferma) e
  // ciò che lo script inline aveva già disegnato va via — altrimenti i suoi
  // `<li>` e quelli di React si sommano. È deliberatamente una scrittura nel
  // DOM fuori dal render: quei nodi React non li conosce, e non c'è altro modo
  // di rimuoverli. Rimuove SOLO i nodi marcati, mai i propri.
  useEffect(() => {
    for (const lista of Array.from(document.querySelectorAll('[data-kv-elenco]'))) {
      lista.setAttribute(ATTRIBUTO_POSSESSO, 'react');
      for (const voce of Array.from(lista.querySelectorAll(`[${ATTRIBUTO_INLINE}]`))) {
        voce.remove();
      }
    }
  }, []);

  // `lang` sul documento è l'unico pezzo che non può stare nel render: `<html>`
  // appartiene al layout radice, che questa pagina non controlla. Scriverlo è
  // esattamente ciò per cui esistono gli effetti — sincronizzare un sistema
  // esterno con lo stato di React.
  useEffect(() => {
    document.documentElement.lang = lingua;
  }, [lingua]);

  // Elenco: si rilegge la CacheStorage DOPO l'idratazione. Non è un doppione
  // dello script inline, è il turno di React — vedi il commento in testa.
  useEffect(() => {
    let vivo = true;
    void leggiRotteInCache(window.location.origin).then((trovate) => {
      if (vivo) setRotte(trovate);
    });
    return () => {
      vivo = false;
    };
  }, []);

  const riprova = useCallback(
    (ev: React.MouseEvent<HTMLAnchorElement>) => {
      // Senza JS l'`<a href="/">` naviga davvero: è il comportamento di ripiego.
      // Con JS si sonda prima, altrimenti si torna nel loop che questa pagina
      // esiste per chiudere.
      ev.preventDefault();
      if (sondaInCorso) return;
      setSondaInCorso(true);
      setNessunaRete(false);
      void sondaRete().then((raggiungibile) => {
        setSondaInCorso(false);
        if (raggiungibile) {
          window.location.assign('/');
          return;
        }
        setNessunaRete(true);
      });
    },
    [sondaInCorso],
  );

  return (
    <>
      {LINGUE.map((l) => {
        const t = testi[l];
        return (
          <div
            key={l}
            data-kv-lang={l}
            hidden={l !== lingua}
            className="flex w-full max-w-sm flex-col items-center gap-5"
          >
            <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">
              {t.titolo}
            </h1>
            {/* Due varianti del paragrafo, entrambe già nel documento: senza JS —
                e quando in cache non c'è nulla — resta visibile quella che NON
                promette pagine consultabili. */}
            <p
              data-kv-corpo="cache"
              hidden={rotte.length === 0}
              className="font-maven text-[15px] leading-relaxed text-white/85"
            >
              {t.corpo}
            </p>
            <p
              data-kv-corpo="vuota"
              hidden={rotte.length > 0}
              className="font-maven text-[15px] leading-relaxed text-white/85"
            >
              {t.corpoSenzaCache}
            </p>

            <nav
              data-kv-disponibili=""
              hidden={rotte.length === 0}
              aria-labelledby={`kv-disponibili-${l}`}
              className="w-full"
            >
              <h2
                id={`kv-disponibili-${l}`}
                className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-yellow"
              >
                {t.disponibili}
              </h2>
              <ul data-kv-elenco={l} className="flex flex-col gap-2 text-left">
                {rotte.map((rotta) => (
                  <li key={rotta}>
                    {/* `<a>` e NON `<Link>`, di proposito: senza rete non c'è
                        prefetch né payload RSC da scaricare, e serve una
                        navigazione VERA che ripassi dal Service Worker. */}
                    <a href={rotta} className={CLASSI_LINK}>
                      {etichettaRotta(t.etichette, rotta)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              data-kv-riprova=""
              onClick={riprova}
              className="inline-flex items-center rounded-pill bg-kidville-yellow px-7 py-3 font-barlow text-sm font-black uppercase tracking-wide text-kidville-green active:scale-95"
            >
              {t.riprova}
            </a>
            <p
              data-kv-nessuna-rete=""
              hidden={!nessunaRete}
              role="status"
              className="font-maven text-sm font-semibold text-kidville-yellow"
            >
              {t.nessunaRete}
            </p>
            <p className="font-maven text-xs text-white/60">{t.nota}</p>
          </div>
        );
      })}
    </>
  );
}
