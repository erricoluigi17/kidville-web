'use client';

import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * Stato online/offline SSR-safe. Usa `useSyncExternalStore`, il modo idiomatico
 * di React per lo stato esterno (navigator.onLine): niente hydration mismatch
 * (getServerSnapshot = online) e niente `setState` sincrono negli effect.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine, // client
    () => true, // server (assume online per l'hydration deterministico)
  );
}
