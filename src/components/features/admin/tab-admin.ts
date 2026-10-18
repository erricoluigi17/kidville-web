import { Home, Bell, Euro, UtensilsCrossed, type LucideIcon } from 'lucide-react';

/**
 * I quattro tab ad alta frequenza del cockpit: Home · Avvisi · Contabilità · Mensa.
 *
 * Li leggono la barra in basso del telefono (`AdminBottomNav`) e il binario del tablet
 * (`AdminBinario`): una lista sola, così le due navigazioni non possono divergere. Href e
 * filtro per ruolo restano quelli della config condivisa (`admin-nav-config.ts`); qui stanno
 * solo l'etichetta breve (namespace `adminNav`, «Home» invece di «Dashboard») e la regola di
 * accensione, che usa l'href risolto da `activeHref` (match più lungo).
 */
export interface TabAdmin {
  href: string;
  /** chiave i18n della label (namespace adminNav). */
  labelKey: string;
  icon: LucideIcon;
  /** attivo dato l'href risolto da activeHref (match più lungo). */
  isActive: (current: string) => boolean;
}

export const TAB_ADMIN: readonly TabAdmin[] = [
  { href: '/admin', labelKey: 'tabHome', icon: Home, isActive: (c) => c === '/admin' },
  { href: '/admin/avvisi', labelKey: 'tabAvvisi', icon: Bell, isActive: (c) => c === '/admin/avvisi' },
  { href: '/admin/pagamenti', labelKey: 'tabContabilita', icon: Euro, isActive: (c) => c === '/admin/pagamenti' },
  {
    href: '/admin/mensa',
    labelKey: 'tabMensa',
    icon: UtensilsCrossed,
    isActive: (c) => c === '/admin/mensa' || c === '/admin/mensa/cucina',
  },
];
