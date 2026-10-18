'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { classeColonnaGenitore } from '@/lib/ui/larghezza-pagina';

/**
 * La colonna dell'area genitore: 430 px sul telefono, 720 da tablet, larga per le rotte
 * dichiarate in `ROTTE_LARGHE_GENITORE`. È un client component solo per leggere il percorso: il
 * layout è un server component, e non sa quale pagina sta incorniciando.
 */
export function ColonnaContenuto({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  return <div className={`relative mx-auto ${classeColonnaGenitore(pathname)}`}>{children}</div>;
}
