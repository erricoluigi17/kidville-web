'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
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
  Menu,
  X,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/students', label: 'Anagrafica', icon: Users },
  { href: '/admin/iscrizioni', label: 'Iscrizioni', icon: ClipboardList },
  { href: '/admin/pagamenti', label: 'Pagamenti', icon: Euro },
  { href: '/admin/mensa', label: 'Mensa', icon: UtensilsCrossed },
  { href: '/admin/primaria', label: 'Primaria', icon: GraduationCap },
  { href: '/admin/modulistica', label: 'Modulistica', icon: FileText },
  { href: '/admin/impostazioni', label: 'Impostazioni', icon: Settings },
  { href: '/admin/tools', label: 'Strumenti', icon: Wrench },
];

function isActive(pathname: string, href: string) {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(href + '/');
}

export function AdminSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Preserva il ?userId= (auth applicativa) su ogni link.
  const userId = searchParams.get('userId');
  const withUser = (href: string) => (userId ? `${href}?userId=${userId}` : href);

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex flex-col gap-1 px-3">
      {NAV.map((item) => {
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
      {/* Topbar mobile */}
      <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between bg-white/90 backdrop-blur border-b border-gray-100 px-4 py-3">
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

      {/* Sidebar desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen border-r border-gray-100 bg-white">
        <Brand />
        <NavList />
      </aside>

      {/* Drawer mobile */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="lg:hidden fixed inset-y-0 left-0 z-50 w-72 bg-white shadow-2xl flex flex-col"
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
