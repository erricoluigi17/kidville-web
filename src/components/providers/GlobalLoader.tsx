'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PageLoader } from '@/components/ui/PageLoader';

/**
 * Mostra il loader globale (variante Riflesso) a OGNI caricamento percepito:
 *  - al **caricamento iniziale** dell'app (finché il client non ha idratato/dipinto);
 *  - a ogni **navigazione** tra pagine (click su link interni, back/forward);
 *  - su richiesta imperativa via {@link showPageLoader} (per `router.push`/`replace`).
 *
 * HYDRATION-SAFE: è un overlay puramente client montato come *fratello* del
 * contenuto in RootProviders, NON un boundary Suspense/`loading.tsx`. Il vecchio
 * root `app/loading.tsx` fu revertato perché avvolgeva l'app in Suspense e in
 * `next dev` impediva l'avvio degli `useEffect` delle pagine client (appello
 * bloccato su "Caricamento alunni"). Qui il contenuto renderizza e si idrata
 * normalmente; l'overlay lo copre e poi svanisce. Usa solo `usePathname` (mai
 * `useSearchParams`, che richiederebbe Suspense e deopterebbe l'app).
 */
const SHOW_DELAY_MS = 180; // anti-flash: le navigazioni istantanee (RSC in cache) non mostrano nulla
const SAFETY_HIDE_MS = 4000; // rete di sicurezza dopo uno "show" senza cambio pathname
const INITIAL_FALLBACK_MS = 2000; // rete di sicurezza per il caricamento iniziale

/** Evento imperativo: qualunque codice può chiamarlo prima di una navigazione
 *  programmatica (`router.push`/`router.replace`) per mostrare subito il loader. */
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
  const prevPath = useRef(pathname);

  // Nasconde a fine navigazione. Usa un ref del pathname precedente (non un
  // boolean) così regge il doppio-invoke di StrictMode e i re-run con pathname
  // invariato: nasconde SOLO quando il pathname cambia davvero.
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    if (safetyTimer.current) { clearTimeout(safetyTimer.current); safetyTimer.current = null; }
    const raf = requestAnimationFrame(() => setVisible(false));
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  // Caricamento iniziale: nascondi appena il client ha idratato e dipinto
  // (primo rAF post-mount), non su window 'load' (che attende tutte le
  // sottorisorse). Fallback breve per sicurezza.
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
        setVisible(true);
        if (safetyTimer.current) clearTimeout(safetyTimer.current);
        safetyTimer.current = setTimeout(() => setVisible(false), SAFETY_HIDE_MS);
      }, SHOW_DELAY_MS);
    };

    // 1) Click su un link interno che cambia pagina. Bubble phase, così
    //    `defaultPrevented` riflette anche gli handler applicativi (un <a> usato
    //    come pulsante che fa preventDefault NON attiva il loader).
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

    // 2) Back/forward. Mostra SOLO se cambia il pathname (a popstate
    //    window.location è già aggiornata, prevPath.current è ancora il vecchio).
    const onPopState = () => {
      if (window.location.pathname !== prevPath.current) scheduleShow();
    };
    window.addEventListener('popstate', onPopState);

    // 3) Trigger imperativo per navigazioni programmatiche (router.push/replace).
    const onImperative = () => scheduleShow();
    window.addEventListener('kv:page-loader:show', onImperative);

    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('kv:page-loader:show', onImperative);
      if (showTimer.current) clearTimeout(showTimer.current);
      if (safetyTimer.current) clearTimeout(safetyTimer.current);
    };
  }, []);

  return <PageLoader visible={visible} />;
}
