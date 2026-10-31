'use client';

import { useCallback, useState } from 'react';
import { activeHref, gruppoDellaPagina } from './admin-nav-config';

/**
 * Lo stato della fisarmonica del menu della segreteria (2026-10-31): UN gruppo aperto alla volta.
 *
 * All'arrivo su una pagina è aperto il suo gruppo (`gruppoDellaPagina`). Toccare un'intestazione
 * apre quel gruppo e chiude l'altro; toccare il gruppo già aperto lo chiude. Quando la pagina
 * cambia (un link nel contenuto, il tasto Indietro) il menu la segue e apre il gruppo nuovo.
 *
 * Il cambio di pagina si gestisce aggiustando lo stato DURANTE il render, non in un `useEffect`:
 * è la stessa mossa della `BarraLaterale` di genitori e docenti e di `AdminBinario`, e l'unica che
 * la regola `react-hooks/set-state-in-effect` accetta.
 *
 * Niente `localStorage`: il valore iniziale dipende solo dalla rotta, che server e client
 * conoscono uguale, quindi l'idratazione non può divergere.
 */
export function useGruppoAperto(
  pathname: string,
  escludi?: ReadonlySet<string>,
): { aperto: string | null; alterna: (chiave: string) => void } {
  const [aperto, setAperto] = useState<string | null>(() => gruppoDellaPagina(activeHref(pathname), escludi));
  const [rottaVista, setRottaVista] = useState(pathname);
  if (rottaVista !== pathname) {
    setRottaVista(pathname);
    setAperto(gruppoDellaPagina(activeHref(pathname), escludi));
  }

  const alterna = useCallback((chiave: string) => {
    setAperto((attuale) => (attuale === chiave ? null : chiave));
  }, []);

  return { aperto, alterna };
}
