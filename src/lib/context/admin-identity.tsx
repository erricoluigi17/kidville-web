'use client';

/**
 * Identità applicativa (userId) del cockpit Direzione/Segreteria.
 *
 * Perché esiste: userId (?userId= / localStorage 'kv_user_id') era letto in TRE
 * punti duplicati (AdminSidebar, AdminTopBar, SedeProvider), e in AdminSidebar
 * finiva negli attributi href dei Link → hydration mismatch in dev (SSR href
 * "nudo" vs client con ?userId=).
 *
 * Soluzione (two-pass SSR-safe via useSyncExternalStore, senza reintrodurre il
 * Suspense che la shell ha volutamente rimosso):
 *  - getServerSnapshot = null → SSR e PRIMO render client = null → gli href
 *    combaciano tra server e client (nessun mismatch);
 *  - getSnapshot = readUserId → dopo l'hydration React ri-renderizza col valore
 *    reale e gli href ricevono ?userId=.
 * Nessun setState sincrono nell'effect (react-hooks 7 compliant).
 */

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

interface AdminIdentityValue {
  userId: string | null;
  ruolo: string;
  /** Appende ?userId= all'href se risolto; altrimenti href invariato (mai userId=null). */
  withUser: (href: string) => string;
}

const AdminIdentityContext = createContext<AdminIdentityValue | null>(null);

function readUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('userId');
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem('kv_user_id');
  } catch {
    return null;
  }
}

// userId non cambia a runtime nella shell admin: subscribe è un no-op stabile.
const subscribe = () => () => {};
const serverSnapshot = () => null;

export function AdminIdentityProvider({ children }: { children: React.ReactNode }) {
  const userId = useSyncExternalStore(subscribe, readUserId, serverSnapshot);
  const [ruolo, setRuolo] = useState('');

  // Ruolo dell'utente (config-driven) risolto una volta lato provider, non più
  // duplicato in sidebar/topbar.
  useEffect(() => {
    if (!userId) return;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [userId]);

  const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);

  return (
    <AdminIdentityContext.Provider value={{ userId, ruolo, withUser }}>
      {children}
    </AdminIdentityContext.Provider>
  );
}

/** Identità applicativa del cockpit. Deve stare dentro <AdminIdentityProvider>. */
export function useAdminIdentity(): AdminIdentityValue {
  const ctx = useContext(AdminIdentityContext);
  if (!ctx) throw new Error('useAdminIdentity deve essere usato dentro <AdminIdentityProvider>');
  return ctx;
}
