'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { motion } from 'framer-motion';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';
import { NAV_GROUPS, activeHref, visibleItem } from './admin-nav-config';

// Voce "Esci" in fondo alla sidebar (il cockpit desktop ha il menu account nella
// TopBar; qui resta come scorciatoia). Su mobile la nav è la bottom-nav +
// bottom-sheet «Menu» (AdminBottomNav/AdminMenuSheet): questa sidebar è solo-desktop.
const LOGOUT_ROW_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold text-kidville-error transition-colors hover:bg-kidville-error-soft';

// Stessa riga del logout, in tinta neutra: l'alto contrasto non è un'azione distruttiva.
const CONTRAST_ROW_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold text-kidville-ink transition-colors hover:bg-kidville-green-soft';

// Sidebar desktop UNICA del cockpit Direzione/Segreteria. La config a gruppi
// (NAV_GROUPS + activeHref + visibleItem) è condivisa con bottom-nav e sheet
// mobile (admin-nav-config.ts). Il `layoutId="admin-nav-active"` vive SOLO qui:
// la pillola animata è dedicata alla sidebar.
export function AdminSidebar() {
  const pathname = usePathname();
  // userId (→ href ?userId=) e ruolo dall'identità condivisa del cockpit. Il
  // provider risolve userId in two-pass (null al primo render, come l'SSR) →
  // gli href della sidebar combaciano e non c'è hydration mismatch.
  const { ruolo, withUser } = useAdminIdentity();

  const current = activeHref(pathname);

  return (
    // Sidebar desktop — sotto la TopBar (top-16, h calc), z-[105] sopra ai modali
    // (z-50/[60]/[100]): resta sempre visibile e cliccabile anche con un modal aperto.
    // Il brand vive nella TopBar → qui si parte dal menu.
    <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] z-[105] border-r border-kidville-line bg-kidville-white overflow-y-auto pt-4">
      <nav className="kv-admin-nav flex flex-col gap-4 px-3 pb-6">
        {NAV_GROUPS.map((group, gi) => {
          const items = group.items.filter((item) => visibleItem(item, ruolo));
          if (items.length === 0) return null;
          return (
            <div key={gi} className="flex flex-col gap-1">
              {group.title && (
                <p className="px-4 pb-1 pt-1 font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-muted">
                  {group.title}
                </p>
              )}
              {items.map((item) => {
                const active = item.href === current;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={withUser(item.href)}
                    aria-current={active ? 'page' : undefined}
                    className={`relative flex items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm transition-colors ${
                      active
                        ? 'text-white'
                        : 'text-kidville-ink/70 hover:bg-kidville-green-soft hover:text-kidville-green'
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="admin-nav-active"
                        className="absolute inset-0 rounded-xl bg-kidville-green shadow-[0_6px_16px_-8px_rgba(0,84,75,0.55)]"
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      />
                    )}
                    <Icon
                      size={20}
                      strokeWidth={2.2}
                      className={`relative z-10 shrink-0 ${active ? 'text-kidville-yellow' : ''}`}
                    />
                    <span className="relative z-10 font-semibold">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-kidville-line px-3 py-3">
        <ContrastMenuButton className={CONTRAST_ROW_CLS} />
        <LogoutMenuButton className={LOGOUT_ROW_CLS} />
      </div>
    </aside>
  );
}
