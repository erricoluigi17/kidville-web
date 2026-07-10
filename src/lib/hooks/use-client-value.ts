'use client';

import { useSyncExternalStore } from 'react';

const noSubscribe = () => () => {};

/**
 * Valore che dipende dall'orologio/fuso locale (es. saluto per fascia oraria,
 * data del giorno), calcolato SOLO client-side. SSR-safe come useOnlineStatus:
 * `getServerSnapshot` ritorna `serverFallback` (niente hydration mismatch fra
 * server UTC e browser locale) e `getSnapshot` il valore reale del client,
 * senza `setState` sincrono negli effect (lock react-hooks/set-state-in-effect).
 *
 * `compute` deve restituire un valore stabile per-render (string/number).
 */
export function useClientValue<T>(compute: () => T, serverFallback: T): T {
  return useSyncExternalStore(noSubscribe, compute, () => serverFallback);
}
