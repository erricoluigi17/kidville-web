'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutDashboard,
  Users,
  ClipboardList,
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
  Menu,
  X,
} from 'lucide-react';

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
const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ href: '/admin', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Didattica',
    items: [
      { href: '/admin/primaria', label: 'Primaria', icon: GraduationCap },
      { href: '/admin/diary', label: 'Diario 0–6', icon: BookOpen },
      { href: '/admin/armadietto', label: 'Armadietto', icon: Package },
    ],
  },
  {
    title: 'Comunicazioni',
    items: [
      { href: '/admin/avvisi', label: 'Avvisi', icon: Bell },
      { href: '/admin/compiti', label: 'Compiti', icon: ListTodo },
    ],
  },
  {
    title: 'Gestione',
    items: [
      { href: '/admin/students', label: 'Anagrafica', icon: Users },
      { href: '/admin/iscrizioni', label: 'Iscrizioni', icon: ClipboardList },
      { href: '/admin/pagamenti', label: 'Pagamenti', icon: Euro },
      { href: '/admin/mensa', label: 'Mensa', icon: UtensilsCrossed },
      { href: '/admin/modulistica', label: 'Modulistica', icon: FileText },
      { href: '/admin/impostazioni', label: 'Impostazioni', icon: Settings },
      { href: '/admin/tools', label: 'Strumenti', icon: Wrench },
    ],
  },
];

function isActive(pathname: string, href: string) {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(href + '/');
}

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [ruolo, setRuolo] = useState('');
  const [userId, setUserId] = useState<string | null>(null);

  // Legge ?userId= (auth applicativa) LATO CLIENT, senza useSearchParams: così la
  // sidebar non "sospende" durante l'SSR delle route dinamiche (es. la classe), dove
  // veniva streamata in un template Suspense nascosto e non compariva. Resa inline.
  useEffect(() => {
    setUserId(new URLSearchParams(window.location.search).get('userId'));
  }, []);
  const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);

  // Ruolo dell'utente per l'eventuale filtro voci (config-driven).
  useEffect(() => {
    if (!userId) return;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [userId]);

  const visible = (item: NavItem) => !item.roles || (!!ruolo && item.roles.includes(ruolo));

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-4 px-3 pb-6">
      {NAV_GROUPS.map((group, gi) => {
        const items = group.items.filter(visible);
        if (items.length === 0) return null;
        return (
          <div key={gi} className="flex flex-col gap-1">
            {group.title && (
              <p className="px-4 pb-1 pt-1 font-maven text-[10px] font-semibold uppercase tracking-wider text-gray-300">
                {group.title}
              </p>
            )}
            {items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={withUser(item.href)}
                  onClick={onNavigate}
                  className={`relative flex items-center gap-3 rounded-xl px-4 py-3 font-maven text-sm transition-colors ${
                    active ? 'text-kidville-green' : 'text-gray-500 hover:text-kidville-green'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="admin-nav-active"
                      className="absolute inset-0 rounded-xl bg-kidville-yellow/30 ring-1 ring-kidville-yellow"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                    />
                  )}
                  <Icon size={20} strokeWidth={2.2} className="relative z-10 shrink-0" />
                  <span className="relative z-10 font-semibold">{item.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  const Brand = () => (
    <div className="flex items-center gap-2 px-6 py-6">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-kidville-green text-kidville-yellow font-barlow font-black">
        K
      </div>
      <div className="leading-none">
        <p className="font-barlow font-black uppercase tracking-wide text-kidville-green text-lg">
          Kidville
        </p>
        <p className="font-maven text-[11px] text-gray-400">Direzione &amp; Segreteria</p>
      </div>
    </div>
  );

  return (
    <>
      {/* Topbar mobile — z sopra agli overlay dei modali (max contenuto z-[100]):
          la cornice persistente non deve mai essere coperta a tutto schermo. */}
      <div className="lg:hidden sticky top-0 z-[105] flex items-center justify-between bg-white/90 backdrop-blur border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-kidville-green text-kidville-yellow font-barlow font-black">
            K
          </div>
          <span className="font-barlow font-black uppercase tracking-wide text-kidville-green">
            Kidville
          </span>
        </div>
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Apri menu"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 text-kidville-green"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* Sidebar desktop — z-[105] sopra ai modali (z-50/[60]/[100]): resta
          sempre visibile e cliccabile anche con un modal aperto. */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen z-[105] border-r border-gray-100 bg-white overflow-y-auto">
        <Brand />
        <NavList />
      </aside>

      {/* Drawer mobile */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="lg:hidden fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="lg:hidden fixed inset-y-0 left-0 z-[120] w-72 bg-white shadow-2xl flex flex-col overflow-y-auto"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            >
              <div className="flex items-center justify-between">
                <Brand />
                <button
                  onClick={() => setMobileOpen(false)}
                  aria-label="Chiudi menu"
                  className="mr-4 flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 text-gray-500"
                >
                  <X size={18} />
                </button>
              </div>
              <NavList onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
