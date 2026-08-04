'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PageLoader } from '@/components/ui/PageLoader';

/**
 * Mostra il loader globale (variante Riflesso) SOLO sui caricamenti lenti:
 *  - **avvio dell'app**: l'overlay è nell'HTML e si nasconde appena il client
 *    ha idratato; su boot lenti resta visibile per tutta l'attesa, su boot
 *    veloci è un lampo trascurabile;
 *  - **navigazioni** tra pagine: appare solo se la transizione supera
 *    {@link SHOW_DELAY_MS} (anti-flash: le navigazioni istantanee non mostrano
 *    nulla), e quando appare resta a schermo per almeno {@link MIN_VISIBLE_MS}
 *    così è ben visibile invece di lampeggiare per un frammento;
 *  - trigger imperativo {@link showPageLoader} per `router.push`/`replace`.
 *
 * HYDRATION-SAFE: overlay puramente client, fratello di `{children}` in
 * RootProviders (NON un boundary Suspense/`loading.tsx`). Solo `usePathname`
 * (mai `useSearchParams`, che deopterebbe l'app).
 */
const SHOW_DELAY_MS = 180; // anti-flash: sotto questa soglia (navigazione istantanea) niente loader
const MIN_VISIBLE_MS = 700; // durata minima a schermo una volta comparso → ben visibile, non un frammento
const SAFETY_HIDE_MS = 4000; // rete di sicurezza dopo uno "show" senza cambio pathname
const INITIAL_FALLBACK_MS = 2000; // rete di sicurezza per il caricamento iniziale

/** Evento imperativo: chiamalo prima di una navigazione programmatica
 *  (`router.push`/`router.replace`) per mostrare il loader se l'attesa è lunga. */
export function showPageLoader() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('kv:page-loader:show'));
  }
}

export function GlobalLoader() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(true); // copre il primo caricamento (SSR incluso)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minVisibleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt = useRef<number | null>(null); // quando l'overlay è comparso per una navigazione
  const prevPath = useRef(pathname);

  /**
   * ⏸️ T09-F1 RESTA APERTO, E QUESTA È LA RAGIONE MISURATA — non una dimenticanza.
   *
   * IL DIFETTO È VERO. Misurato il 2026-08-03 su `/privacy`: con l'overlay a schermo,
   * 4 elementi su 4 raggiungibili col `Tab` risultavano coperti, `pointer-events: auto`,
   * `aria-hidden` assente. Il focus non si vedeva ma c'era: si poteva premere `Invio` su
   * un comando invisibile. Vale su OGNI pagina, per almeno `MIN_VISIBLE_MS`.
   *
   * LA CORREZIONE È STATA SCRITTA, PROVATA IN CI, E RITIRATA. Qui c'era una chiamata a
   * `rendiInerteFuoriDaConFocus(overlay)`, che rende inerte tutto ciò che sta fuori
   * dall'overlay. È corretta in linea di principio e sbagliata nell'effetto, e la CI lo
   * ha dimostrato in modo non ambiguo (run 30911702345 e 30912837972):
   *
   *   · con l'inerzia attiva, TUTTI E TRE i `storageState` fallivano — il campo email
   *     restava VUOTO mentre la password, riempita mezzo secondo dopo, entrava. Nessuno
   *     spec girava;
   *   · sistemata quella, cadevano `admin-search`, `public-iscrizione` e `teacher-diary`:
   *     percorsi diversi, stessa forma. `fill()` non lancia, «riesce», e il valore non
   *     entra.
   *
   * Cioè: **ogni interazione entro la finestra di visibilità dell'overlay viene persa,
   * su ogni pagina**. In CI la finestra c'è quasi sempre, perché l'E2E gira su
   * `next dev`; in produzione è più rara ma non teorica — è la rete lenta, cioè
   * esattamente la condizione di un genitore col telefono in mano davanti a scuola.
   *
   * Si potrebbe obiettare che l'utente non può comunque interagire, perché l'overlay
   * intercetta i click. Vale per il mouse. Non vale per la tastiera, per chi digita in
   * anticipo su un campo che ha già a fuoco, e non vale per le WebView native.
   *
   * PERCHÉ NON SI È SCELTO IL COMPROMESSO: ritardare l'inerzia (applicarla solo se
   * l'overlay resta oltre N ms) sposta il difetto invece di chiuderlo, e crea una
   * finestra in cui il comportamento dipende dalla velocità della rete — cioè la cosa
   * più difficile da provare e la più facile da rompere.
   *
   * COSA SERVE PER CHIUDERLO DAVVERO, ed è lavoro suo: verificare sul browser vero
   * (tastiera, VoiceOver, WebView iOS) se convenga (a) non mostrare l'overlay quando la
   * navigazione è già conclusa — cioè attaccare `MIN_VISIBLE_MS`, che è la causa a monte
   * di tutto questo — oppure (b) rendere inerte il solo contenuto NON interattivo. La
   * primitiva è pronta e provata (`src/lib/accessibility/inerti.ts`), ed è già in uso
   * dove il perimetro è chiuso e la scelta è sicura: dentro `ui/Modal` e nel bottom-sheet
   * della navigazione, dove l'utente ha aperto il pannello di proposito.
   *
   * Un difetto di accessibilità noto e scritto è peggio di un difetto chiuso. È molto
   * meglio di una regressione funzionale su ogni pagina, rilasciata senza una prova sul
   * browser vero.
   */

  // Nasconde a fine navigazione, rispettando la durata minima a schermo. Usa un
  // ref del pathname precedente (non un boolean) → regge lo StrictMode e i re-run
  // con pathname invariato: agisce SOLO quando il pathname cambia davvero.
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    if (minVisibleTimer.current) { clearTimeout(minVisibleTimer.current); minVisibleTimer.current = null; }

    const doHide = () => {
      if (safetyTimer.current) { clearTimeout(safetyTimer.current); safetyTimer.current = null; }
      shownAt.current = null;
      setVisible(false);
    };

    if (shownAt.current == null) {
      // Non era visibile per navigazione (transizione istantanea): assicura hidden.
      const raf = requestAnimationFrame(doHide);
      return () => cancelAnimationFrame(raf);
    }
    // Comparso per navigazione: rispetta la durata minima a schermo.
    const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt.current);
    if (remaining <= 0) {
      const raf = requestAnimationFrame(doHide);
      return () => cancelAnimationFrame(raf);
    }
    minVisibleTimer.current = setTimeout(doHide, remaining);
    return () => {
      if (minVisibleTimer.current) { clearTimeout(minVisibleTimer.current); minVisibleTimer.current = null; }
    };
  }, [pathname]);

  // Caricamento iniziale: nascondi appena il client ha idratato e dipinto (primo
  // rAF post-mount), non su window 'load'. Nessuna durata minima → su boot veloci
  // è un lampo, su boot lenti l'HTML lo mostra per tutta l'attesa.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(false));
    const fallback = setTimeout(() => setVisible(false), INITIAL_FALLBACK_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
    };
  }, []);

  // Inizio navigazione → mostra il loader (con ritardo anti-flash).
  useEffect(() => {
    const scheduleShow = () => {
      if (showTimer.current) return;
      showTimer.current = setTimeout(() => {
        showTimer.current = null;
        shownAt.current = Date.now();
        setVisible(true);
        if (safetyTimer.current) clearTimeout(safetyTimer.current);
        safetyTimer.current = setTimeout(() => {
          shownAt.current = null;
          setVisible(false);
        }, SAFETY_HIDE_MS);
      }, SHOW_DELAY_MS);
    };

    // 1) Click su un link interno che cambia pagina. Bubble phase, così
    //    `defaultPrevented` riflette anche gli handler applicativi.
    const onDocClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.('a');
      if (!a) return;
      if (a.target && a.target !== '_self') return; // _blank ecc.
      if (a.hasAttribute('download')) return;
      const rel = (a.getAttribute('rel') || '').split(/\s+/);
      if (rel.includes('external')) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return; // stessa pagina (hash/query) → niente loader
      scheduleShow();
    };
    document.addEventListener('click', onDocClick);

    // 2) Back/forward. Mostra SOLO se cambia il pathname.
    const onPopState = () => {
      if (window.location.pathname !== prevPath.current) scheduleShow();
    };
    window.addEventListener('popstate', onPopState);

    // 3) Trigger imperativo per navigazioni programmatiche.
    const onImperative = () => scheduleShow();
    window.addEventListener('kv:page-loader:show', onImperative);

    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('kv:page-loader:show', onImperative);
      if (showTimer.current) clearTimeout(showTimer.current);
      if (safetyTimer.current) clearTimeout(safetyTimer.current);
      if (minVisibleTimer.current) clearTimeout(minVisibleTimer.current);
    };
  }, []);

  return <PageLoader visible={visible} />;
}
