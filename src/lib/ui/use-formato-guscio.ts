'use client';

import { useSyncExternalStore } from 'react';

/**
 * Da 744 px — l'iPad mini in verticale, il più stretto degli iPad — il guscio di genitori e
 * docenti lascia la barra in basso per un binario a icone a sinistra. Stessa misura di
 * `--breakpoint-tablet` in `globals.css`.
 */
export const QUERY_TABLET = '(min-width: 46.5rem)';

/** Da 1024 px (iPad 13" in verticale, 11" in orizzontale) il binario diventa una sidebar con tutte le voci. */
export const QUERY_SIDEBAR = '(min-width: 64rem)';

export type FormatoGuscio = 'telefono' | 'binario' | 'sidebar';

const haMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function iscriviti(avvisa: () => void): () => void {
  if (!haMatchMedia()) return () => {};
  const query = [window.matchMedia(QUERY_TABLET), window.matchMedia(QUERY_SIDEBAR)];
  query.forEach((q) => q.addEventListener('change', avvisa));
  return () => query.forEach((q) => q.removeEventListener('change', avvisa));
}

function leggi(): FormatoGuscio {
  if (!haMatchMedia()) return 'telefono';
  if (window.matchMedia(QUERY_SIDEBAR).matches) return 'sidebar';
  return window.matchMedia(QUERY_TABLET).matches ? 'binario' : 'telefono';
}

/**
 * Quale navigazione montare.
 *
 * Il server e il primo render del client rispondono `telefono`, così l'HTML coincide e
 * l'idratazione non si rompe. Sul tablet la barra in basso resta invisibile (`tablet:hidden`)
 * per l'istante che precede l'idratazione, poi lascia il posto al binario.
 *
 * Si monta UNA navigazione sola, non tre nascoste a turno dal CSS: con due nel DOM, una
 * invisibile, un `getByText('Chat')` negli E2E ne troverebbe due, e così i flow Maestro che
 * toccano le voci per testo. Dove `matchMedia` non risponde (server, jsdom) la risposta è
 * `telefono`: il comportamento di sempre.
 */
export function useFormatoGuscio(): FormatoGuscio {
  return useSyncExternalStore(iscriviti, leggi, () => 'telefono');
}
