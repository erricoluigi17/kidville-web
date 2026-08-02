'use client';

/**
 * Identità docente SSR-safe per ciò che finisce RENDERIZZATO (href, action, …).
 *
 * PERCHÉ ESISTE. `getCurrentTeacherId()` legge `localStorage`, che sul server
 * non esiste: chiamarla nel corpo di un componente dà `null` in SSR e l'uuid
 * vero al primo render del browser. Se quel valore entra in un attributo — è il
 * caso di `TeacherBottomNav` e `ClasseShell` — React segnala un mismatch di
 * idratazione a ogni caricamento e **non ripara gli attributi**: al docente
 * resta davvero sotto il dito un `href="/teacher?userId=null"`, e quella
 * stringa «null» viaggia poi come identità dentro le route `/api/*`.
 *
 * COME. Lo stesso schema a due passaggi già usato dalla shell del cockpit
 * (`useAdminIdentity`), via `useSyncExternalStore`:
 *  · `getServerSnapshot` → `null`: SSR e PRIMO render client coincidono, quindi
 *    l'HTML combacia e non c'è niente da riparare;
 *  · `getSnapshot` → l'identità reale: subito dopo l'idratazione React
 *    ri-renderizza e gli href ricevono l'uuid.
 * Nessun `setState` dentro un effetto (lock `react-hooks/set-state-in-effect`).
 *
 * `withUser` OMETTE il parametro quando l'identità non è ancora risolta: è
 * l'unico modo per rendere `userId=null` impossibile per costruzione, invece di
 * affidarsi a chi scrive il prossimo href.
 */

import { useSyncExternalStore } from 'react';
import { getCurrentTeacherId } from './current-teacher';

// L'identità non cambia a runtime dentro una schermata: subscribe è un no-op
// stabile (come in admin-identity), il ri-render lo fa l'idratazione.
const subscribe = () => () => {};
const vero = () => true;
const falso = () => false;

export interface TeacherIdentity {
  /** `null` in SSR e al primo render client; l'uuid subito dopo l'idratazione. */
  userId: string | null;
  /**
   * `false` finché siamo nel passaggio che deve combaciare col server.
   * Serve agli EFFETTI: partire prima significherebbe una chiamata in più (e
   * con l'identità sbagliata) su ogni apertura di pagina. Quando è `true`,
   * `userId` è definitivo — `null` vuol dire davvero «nessuna identità locale»,
   * caso in cui la risolve la sessione server-side.
   */
  pronta: boolean;
  /** Appende `?userId=` solo se l'identità è risolta. Mai `userId=null`. */
  withUser: (href: string) => string;
}

export function useTeacherIdentity(params?: URLSearchParams | null): TeacherIdentity {
  // Il `?userId=` della URL il server CE L'HA: rinunciarci significherebbe
  // servire i link nudi anche a chi è arrivato da un deep link. È solo la parte
  // che vive in `localStorage` a dover aspettare l'idratazione.
  const daUrl = params?.get('userId') || null;

  const userId = useSyncExternalStore(
    subscribe,
    () => getCurrentTeacherId(params),
    () => daUrl,
  );
  const pronta = useSyncExternalStore(subscribe, vero, falso);

  const withUser = (href: string): string => {
    if (!userId) return href;
    const sep = href.includes('?') ? '&' : '?';
    return `${href}${sep}userId=${encodeURIComponent(userId)}`;
  };

  return { userId, pronta, withUser };
}
