'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutDashboard,
  Users,
  Euro,
  UtensilsCrossed,
  GraduationCap,
  FileText,
  Settings,
  Wrench,
  Bell,
  ListTodo,
  Package,
  BookOpen,
  Award,
  ShieldCheck,
  ChefHat,
  ShoppingBag,
  MessageCircle,
  Stamp,
  Menu,
  X,
} from 'lucide-react';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';

// Voce "Esci" in fondo alla sidebar/drawer (il cockpit desktop ha il menu account
// nella TopBar; qui serve per il mobile e come scorciatoia desktop).
const LOGOUT_ROW_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold text-kidville-error transition-colors hover:bg-kidville-error-soft';

// Stessa riga del logout, in tinta neutra: l'alto contrasto non è un'azione distruttiva.
const CONTRAST_ROW_CLS =
  'flex w-full items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm font-semibold text-kidville-ink transition-colors hover:bg-kidville-green-soft';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: string[]; // se assente → visibile a tutti i ruoli staff
}

interface NavGroup {
  title: string | null;
  items: NavItem[];
}

// Sidebar UNICA del cockpit Direzione/Segreteria, guidata da config a gruppi.
// Il ruolo determina (a) lo scope dati (a livello API) e (b) — via `roles` —
// l'eventuale visibilità delle voci. Oggi tutte le voci sono visibili a entrambi.
// Gruppi come nel design cockpit (DR segreteria-direzione): raggruppo per area.
// Mappo SOLO rotte reali; aggiungo Competenze e GDPR (rotte reali oggi non in
// sidebar). Le voci DR senza backend (monitor Presenze globale, editor Registro/
// Palinsesto, Fatturazione dedicata) NON entrano qui: sarebbero nav morte → LISTA 1.
const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ href: '/admin', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Anagrafica',
    items: [
      { href: '/admin/students', label: 'Anagrafica', icon: Users },
    ],
  },
  {
    title: 'Didattica',
    items: [
      { href: '/admin/primaria', label: 'Primaria', icon: GraduationCap },
      { href: '/admin/diary', label: 'Diario 0–6', icon: BookOpen },
      { href: '/admin/competenze', label: 'Competenze', icon: Award },
    ],
  },
  {
    title: 'Operativo',
    items: [
      { href: '/admin/armadietto', label: 'Armadietto', icon: Package },
      { href: '/admin/merchandise', label: 'Merchandise', icon: ShoppingBag },
      { href: '/admin/mensa', label: 'Mensa', icon: UtensilsCrossed },
      { href: '/admin/mensa/cucina', label: 'Report Cucina', icon: ChefHat },
    ],
  },
  {
    title: 'Amministrazione',
    items: [
      { href: '/admin/pagamenti', label: 'Contabilità', icon: Euro },
      // Registro protocolli: riservato ad admin+segreteria (decisione spec
      // 2026-07-12); primo uso reale del campo `roles` (il gate vero è nelle API).
      { href: '/admin/protocolli', label: 'Protocollo', icon: Stamp, roles: ['admin', 'segreteria'] },
      { href: '/admin/modulistica', label: 'Modulistica', icon: FileText },
      { href: '/admin/gdpr', label: 'Privacy & GDPR', icon: ShieldCheck },
    ],
  },
  {
    title: 'Comunicazione',
    items: [
      { href: '/admin/messaggi', label: 'Messaggi', icon: MessageCircle },
      { href: '/admin/avvisi', label: 'Avvisi', icon: Bell },
      { href: '/admin/compiti', label: 'Compiti', icon: ListTodo },
    ],
  },
  {
    title: 'Sistema',
    items: [
      { href: '/admin/impostazioni', label: 'Impostazioni', icon: Settings },
      { href: '/admin/tools', label: 'Strumenti', icon: Wrench },
    ],
  },
];

const ALL_HREFS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

// href attivo = il match più SPECIFICO (più lungo), così su /admin/mensa/cucina
// si evidenzia "Report Cucina" e non anche "Mensa". '/admin' resta esatto.
function activeHref(pathname: string) {
  let best = '';
  for (const href of ALL_HREFS) {
    const match = href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(href + '/');
    if (match && href.length > best.length) best = href;
  }
  return best;
}

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // userId (→ href ?userId=) e ruolo dall'identità condivisa del cockpit. Il
  // provider risolve userId in two-pass (null al primo render, come l'SSR) →
  // gli href della sidebar combaciano e non c'è hydration mismatch.
  const { ruolo, withUser } = useAdminIdentity();

  const visible = (item: NavItem) => !item.roles || (!!ruolo && item.roles.includes(ruolo));

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => {
    const current = activeHref(pathname);
    return (
    <nav className="kv-admin-nav flex flex-col gap-4 px-3 pb-6">
      {NAV_GROUPS.map((group, gi) => {
        const items = group.items.filter(visible);
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
                  onClick={onNavigate}
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
    );
  };

  const Brand = () => (
    <div className="flex items-center gap-2 px-6 py-6">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-kidville-green text-kidville-yellow font-barlow font-black">
        K
      </div>
      <div className="leading-none">
        <p className="font-barlow font-black uppercase tracking-wide text-kidville-green text-lg">
          Kidville
        </p>
        <p className="font-maven text-[11px] text-kidville-muted">Direzione &amp; Segreteria</p>
      </div>
    </div>
  );

  return (
    <>
      {/* Topbar mobile — z sopra agli overlay dei modali (max contenuto z-[100]):
          la cornice persistente non deve mai essere coperta a tutto schermo. */}
      <div className="kv-admin-topbar lg:hidden sticky top-0 z-[105] flex items-center justify-between bg-kidville-white/90 backdrop-blur border-b border-kidville-line px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-kidville-green text-kidville-yellow font-barlow font-black">
            K
          </div>
          <span className="font-barlow font-black uppercase tracking-wide text-kidville-green">
            Kidville
          </span>
        </div>
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Apri menu"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-kidville-line text-kidville-green transition-colors hover:bg-kidville-green-soft active:scale-95"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* Sidebar desktop — sotto la TopBar (top-16, h calc), z-[105] sopra ai modali
          (z-50/[60]/[100]): resta sempre visibile e cliccabile anche con un modal aperto.
          Il brand vive nella TopBar → qui si parte dal menu. */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] z-[105] border-r border-kidville-line bg-kidville-white overflow-y-auto pt-4">
        {NavList({})}
        <div className="mt-auto border-t border-kidville-line px-3 py-3">
          <ContrastMenuButton className={CONTRAST_ROW_CLS} />
          <LogoutMenuButton className={LOGOUT_ROW_CLS} />
        </div>
      </aside>

      {/* Drawer mobile */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="lg:hidden fixed inset-0 z-[110] bg-kidville-green/30 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="lg:hidden fixed inset-y-0 left-0 z-[120] w-72 rounded-r-3xl bg-kidville-white shadow-2xl flex flex-col overflow-y-auto"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            >
              <div className="flex items-center justify-between">
                {Brand()}
                <button
                  onClick={() => setMobileOpen(false)}
                  aria-label="Chiudi menu"
                  className="mr-4 flex h-9 w-9 items-center justify-center rounded-full bg-kidville-green-soft text-kidville-green transition-colors hover:bg-kidville-green hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>
              {NavList({ onNavigate: () => setMobileOpen(false) })}
              <div className="mt-auto border-t border-kidville-line px-3 py-3">
                <ContrastMenuButton className={CONTRAST_ROW_CLS} />
                <LogoutMenuButton className={LOGOUT_ROW_CLS} />
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
