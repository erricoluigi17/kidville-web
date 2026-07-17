'use client';

/**
 * Bottom-nav mobile del cockpit Direzione/Segreteria (<lg).
 *
 * Mutua il linguaggio della BottomNav genitore/docente (pillola bianca fluttuante,
 * icona in un pill che diventa verde da attiva, label in maiuscolo) SENZA
 * riusarne il codice — il perimetro genitore/docente resta intatto. Composizione
 * decisa dall'utente: 4 tab ad alta frequenza + un bottone «Menu» che apre il
 * bottom-sheet con tutte le altre sezioni (`AdminMenuSheet`).
 *
 * Tab: Home (/admin, match esatto) · Avvisi · Contabilità (/admin/pagamenti) ·
 * Mensa (/admin/mensa, acceso anche su /admin/mensa/cucina). Lo stato attivo usa
 * lo stesso `activeHref` (match più lungo) della sidebar/config condivisa; quando
 * lo sheet «Menu» è aperto i tab cedono l'attivo al Menu (mutua esclusività: una
 * sola voce accesa).
 *
 * Colori SOLO via token — mai hex letterali (lock `design-tokens-admin` su
 * `features/admin/**`). Il pill attivo porta la classe `bg-kidville-green` e
 * l'icona `text-kidville-yellow`: sono i ganci delle regole Alto Contrasto di
 * `.kv-admin-bottomnav` in globals.css (`[aria-current="page"]`/`[aria-expanded]`).
 * Gli href viaggiano con `?userId=` via `withUser` (identità del cockpit),
 * risolta two-pass SSR-safe → nessun hydration mismatch.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Bell, Euro, UtensilsCrossed, LayoutGrid } from 'lucide-react';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { activeHref, visibleItem, NAV_GROUPS, type NavItem } from './admin-nav-config';
import { AdminMenuSheet } from './AdminMenuSheet';

const FLAT: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

interface Tab {
  href: string;
  label: string;
  icon: typeof Home;
  /** attivo dato l'href risolto da activeHref (match più lungo). */
  isActive: (current: string) => boolean;
}

// 4 tab reali del cockpit. Label proprie della nav mobile (Home invece di
// "Dashboard"); href e gating (roles) restano quelli della config condivisa.
const TABS: Tab[] = [
  { href: '/admin', label: 'Home', icon: Home, isActive: (c) => c === '/admin' },
  { href: '/admin/avvisi', label: 'Avvisi', icon: Bell, isActive: (c) => c === '/admin/avvisi' },
  { href: '/admin/pagamenti', label: 'Contabilità', icon: Euro, isActive: (c) => c === '/admin/pagamenti' },
  {
    href: '/admin/mensa',
    label: 'Mensa',
    icon: UtensilsCrossed,
    isActive: (c) => c === '/admin/mensa' || c === '/admin/mensa/cucina',
  },
];

// pill dell'icona: 44px di area toccabile, verde da attivo (gancio HC).
const PILL_BASE =
  'flex items-center justify-center w-11 h-8 rounded-full transition-colors';

export function AdminBottomNav() {
  const pathname = usePathname();
  const { ruolo, withUser } = useAdminIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const current = activeHref(pathname);

  // Il bottone «Menu» si accende quando lo sheet è aperto OPPURE quando la rotta
  // corrente è una sezione dello sheet (nessuno dei 4 tab è attivo, ma la voce
  // vive nei gruppi «Menu»). Mutua la logica di feedback-di-posizione della
  // BottomNav genitore/docente: una sola voce accesa per volta.
  const anyTabActive = TABS.some((t) => t.isActive(current));
  const menuActive = menuOpen || (!anyTabActive && FLAT.some((i) => i.href === current));

  return (
    <>
      <div
        className="lg:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[520px] z-50 px-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <div className="kv-admin-bottomnav bg-kidville-white/95 backdrop-blur-2xl rounded-[26px] border border-kidville-line shadow-[0_-2px_24px_rgba(0,106,95,0.10),0_8px_32px_rgba(0,0,0,0.08)]">
          <nav aria-label="Navigazione cockpit" className="flex items-stretch justify-around px-1 h-[60px]">
            {TABS.map((tab) => {
              // Gating per ruolo dalla config (nessuno dei 4 tab ha `roles` oggi:
              // no-op, ma resta la sorgente di verità unica).
              const cfg = FLAT.find((i) => i.href === tab.href);
              if (cfg && !visibleItem(cfg, ruolo)) return null;

              const active = tab.isActive(current) && !menuOpen;
              const Icon = tab.icon;
              return (
                <Link
                  key={tab.href}
                  href={withUser(tab.href)}
                  aria-current={active ? 'page' : undefined}
                  className="flex flex-col items-center justify-center gap-[3px] flex-1 min-h-[44px] py-1"
                >
                  <span className={`${PILL_BASE} ${active ? 'bg-kidville-green' : ''}`}>
                    <Icon
                      size={18}
                      strokeWidth={2}
                      className={active ? 'text-kidville-yellow' : 'text-kidville-sub'}
                    />
                  </span>
                  <span
                    className={`text-[9px] font-barlow font-bold uppercase tracking-wider ${
                      active ? 'text-kidville-green' : 'text-kidville-sub'
                    }`}
                  >
                    {tab.label}
                  </span>
                </Link>
              );
            })}

            <button
              ref={menuBtnRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              // A sheet chiuso, quando la rotta è una sezione del Menu, marca il
              // bottone come voce corrente: è anche il gancio delle regole Alto
              // Contrasto (`[aria-current="true"]` → pill nero + icona gialla),
              // dato che `aria-expanded="true"` copre solo lo sheet aperto.
              aria-current={menuActive && !menuOpen ? 'true' : undefined}
              aria-label="Menu · tutte le sezioni"
              className="flex flex-col items-center justify-center gap-[3px] flex-1 min-h-[44px] py-1"
            >
              <span className={`${PILL_BASE} ${menuActive ? 'bg-kidville-green' : ''}`}>
                <LayoutGrid
                  size={18}
                  strokeWidth={2}
                  className={menuActive ? 'text-kidville-yellow' : 'text-kidville-sub'}
                />
              </span>
              <span
                className={`text-[9px] font-barlow font-bold uppercase tracking-wider ${
                  menuActive ? 'text-kidville-green' : 'text-kidville-sub'
                }`}
              >
                Menu
              </span>
            </button>
          </nav>
        </div>
      </div>

      <AdminMenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        withUser={withUser}
        ruolo={ruolo}
        returnFocusRef={menuBtnRef}
      />
    </>
  );
}
