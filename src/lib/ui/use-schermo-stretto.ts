'use client';

import { useSyncExternalStore } from 'react';

/**
 * Sotto i 1024 px — il punto `lg` di Tailwind — il dettaglio di un elenco lungo smette di stare
 * in una colonna accanto alla lista e si apre in un foglio sopra di essa (vedi
 * `ColonnaDettaglio`). Dal 2026-10-18 nel cockpit la barra in alto da 64 px c'è già da 744 px,
 * col binario del tablet: sotto i 1024 è lo spazio a mancare, non l'appoggio della colonna.
 *
 * `1023.98` e non `1023`: con lo zoom del browser le larghezze sono frazionarie, e fra 1023 e
 * 1024 esisterebbe una finestra in cui né questa query né `lg:` valgono.
 */
export const QUERY_SCHERMO_STRETTO = '(max-width: 1023.98px)';

function iscriviti(avvisa: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(QUERY_SCHERMO_STRETTO);
  mql.addEventListener('change', avvisa);
  return () => mql.removeEventListener('change', avvisa);
}

function leggi(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY_SCHERMO_STRETTO).matches;
}

/**
 * Lo schermo è stretto? La domanda è posta al contrario apposta: dove `matchMedia` non
 * risponde (il server, i browser che non l'hanno, il setup dei test che la simula sempre
 * `false`) la risposta è «no», cioè la colonna a destra — il comportamento che c'era prima.
 * Un default «telefono» trasformerebbe in un foglio modale ogni dettaglio provato in jsdom.
 */
export function useSchermoStretto(): boolean {
  return useSyncExternalStore(iscriviti, leggi, () => false);
}
