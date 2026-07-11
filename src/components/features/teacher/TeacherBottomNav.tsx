'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import {
  Home, NotebookPen, MessageCircle, BookOpen, LayoutGrid,
  Image, Package, FileText, ClipboardCheck, Users, Megaphone,
  ListTodo, UtensilsCrossed, CalendarDays, User, X, ChevronRight,
} from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';

// ============================================================================
// TeacherBottomNav — bottom bar persistente del design (DR ins/screen-home.jsx
// ShellTabBar + MenuSheet), mirror del pattern Genitore (parent/BottomNav).
// Naviga SOLO rotte teacher esistenti; le voci del DR senza rotta (Calendario /
// Profilo) sono rese NON navigabili con badge "In arrivo". La Mensa ha ora una
// vista docente read-only (/teacher/mensa).
// Propaga ?userId= su ogni href (le pagine teacher risolvono l'identità via query).
// ============================================================================

interface MenuItem {
  id: string;
  label: string;
  sub: string;
  icon: typeof Home;
  href: string | null; // null = funzione non ancora navigabile (no rotta reale)
  tint: string;
  soon?: boolean;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

export default function TeacherBottomNav() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [showMenu, setShowMenu] = useState(false);
  const userId = getCurrentTeacherId(search);
  const withUser = (href: string) => `${href}?userId=${userId}`;

  // Mondo primaria attivo dal contesto di navigazione (no fetch extra).
  const isPrimaria = pathname.startsWith('/teacher/primaria');

  // Menu raggruppato del DR (TEACHER_MENU), mappato alle rotte reali.
  const groups: MenuGroup[] = [
    {
      label: 'In classe',
      items: [
        { id: 'appello', label: 'Appello', sub: 'Presenze del giorno', icon: ClipboardCheck, href: '/teacher/attendance', tint: '#006A5F' },
        { id: 'diario', label: 'Diario', sub: 'Schede giornaliere', icon: NotebookPen, href: '/teacher/diary', tint: '#2A6FDB' },
        { id: 'registro', label: 'Registro', sub: 'Le mie classi · valutazioni', icon: BookOpen, href: '/teacher/primaria', tint: '#7A3FD0' },
        { id: 'presenze', label: 'Presenze', sub: 'Riepilogo assenze', icon: Users, href: '/teacher/attendance', tint: '#43A047' },
      ],
    },
    {
      label: 'Vita scolastica',
      items: [
        { id: 'mensa', label: 'Mensa', sub: 'Prenotazioni pranzo', icon: UtensilsCrossed, href: '/teacher/mensa', tint: '#E6720A' },
        { id: 'foto', label: 'Foto', sub: 'Galleria sezione', icon: Image, href: '/teacher/gallery', tint: '#006A5F' },
        { id: 'bacheca', label: 'Bacheca', sub: 'Avvisi e comunicazioni', icon: Megaphone, href: '/teacher/avvisi', tint: '#E53935' },
        { id: 'calendario', label: 'Calendario', sub: 'Eventi e uscite', icon: CalendarDays, href: null, tint: '#2A6FDB', soon: true },
      ],
    },
    {
      label: 'Strumenti',
      items: [
        { id: 'attivita', label: 'Attività', sub: 'Attività e bacheca interna', icon: ListTodo, href: '/teacher/tasks', tint: '#1F8A5B' },
        { id: 'armadietto', label: 'Armadietto', sub: 'Scorte e richieste', icon: Package, href: '/teacher/locker', tint: '#7A3FD0' },
        { id: 'moduli', label: 'Moduli', sub: 'Form da gestire', icon: FileText, href: '/teacher/modulistica', tint: '#E6720A' },
        { id: 'messaggi', label: 'Messaggi', sub: 'Chat con le famiglie', icon: MessageCircle, href: '/teacher/chat', tint: '#006A5F' },
        { id: 'profilo', label: 'Profilo', sub: 'Account e impostazioni', icon: User, href: null, tint: '#7C8A84', soon: true },
      ],
    },
  ];

  // Tab principali (ordine DR: Dashboard / Diario·Registro / Messaggi / Foto / Menu).
  const mainTabs = [
    { id: 'home', label: 'Dashboard', icon: Home, href: '/teacher' as const },
    isPrimaria
      ? { id: 'registro', label: 'Registro', icon: BookOpen, href: '/teacher/primaria' as const }
      : { id: 'diario', label: 'Diario', icon: NotebookPen, href: '/teacher/diary' as const },
    { id: 'messaggi', label: 'Messaggi', icon: MessageCircle, href: '/teacher/chat' as const },
    { id: 'foto', label: 'Foto', icon: Image, href: '/teacher/gallery' as const },
    { id: 'menu', label: 'Menu', icon: LayoutGrid, href: null },
  ] as const;

  const isActive = (href: string) => {
    if (href === '/teacher') return pathname === '/teacher';
    return pathname.startsWith(href);
  };

  const isMenuSectionActive = groups.some((g) =>
    g.items.some((i) => i.href && pathname.startsWith(i.href)),
  );
  // Mutua esclusività: il MENU non si accende sulle rotte già coperte da un tab
  // dedicato (Dashboard/Diario·Registro/Messaggi/Foto) → una sola voce attiva.
  const anyMainTabActive = mainTabs.some((t) => t.href && isActive(t.href));

  return (
    <>
      {/* ── BOTTOM NAV PILL ─────────────────────── */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[460px] z-50 px-3 pb-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="bg-white/96 backdrop-blur-2xl rounded-[26px] shadow-[0_-2px_24px_rgba(0,106,95,0.10),0_8px_32px_rgba(0,0,0,0.08)] border border-white/60">
          <nav aria-label="Navigazione principale" className="flex items-stretch justify-around px-1 h-[60px]">
            {mainTabs.map((tab) => {
              const Icon = tab.icon;
              const active = tab.href ? isActive(tab.href) : ((isMenuSectionActive && !anyMainTabActive) || showMenu);

              if (tab.id === 'menu') {
                return (
                  <button
                    key="menu"
                    onClick={() => setShowMenu((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={showMenu}
                    aria-label="Menu · tutte le sezioni"
                    className="flex flex-col items-center justify-center gap-[3px] flex-1 py-1 relative"
                  >
                    <motion.div
                      animate={active ? { backgroundColor: '#006A5F', scale: 1.05 } : { backgroundColor: 'transparent', scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className="w-10 h-[30px] rounded-full flex items-center justify-center"
                    >
                      <Icon
                        className="w-[18px] h-[18px] transition-colors duration-200"
                        style={{ color: active ? '#FDC400' : '#9CA3AF' }}
                        strokeWidth={2}
                      />
                    </motion.div>
                    <span
                      className="text-[9px] font-barlow font-bold uppercase tracking-wider transition-colors duration-200"
                      style={{ color: active ? '#006A5F' : '#9CA3AF' }}
                    >
                      {tab.label}
                    </span>
                  </button>
                );
              }

              return (
                <Link
                  key={tab.id}
                  href={withUser(tab.href!)}
                  aria-current={active ? 'page' : undefined}
                  className="flex flex-col items-center justify-center gap-[3px] flex-1 py-1 relative"
                >
                  <motion.div
                    animate={active ? { backgroundColor: '#006A5F', scale: 1.05 } : { backgroundColor: 'transparent', scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className="w-10 h-[30px] rounded-full flex items-center justify-center"
                  >
                    <Icon
                      className="w-[18px] h-[18px] transition-colors duration-200"
                      style={{ color: active ? '#FDC400' : '#9CA3AF' }}
                      strokeWidth={2}
                    />
                  </motion.div>
                  <span
                    className="text-[9px] font-barlow font-bold uppercase tracking-wider transition-colors duration-200"
                    style={{ color: active ? '#006A5F' : '#9CA3AF' }}
                  >
                    {tab.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ── MENU BOTTOM SHEET (DR raggruppato) ──── */}
      <AnimatePresence>
        {showMenu && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-kidville-green/30 backdrop-blur-[2px] z-40"
              onClick={() => setShowMenu(false)}
            />

            <motion.div
              key="sheet"
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              className="fixed left-1/2 -translate-x-1/2 w-full max-w-[460px] z-50 px-4"
              style={{ bottom: 'max(84px, calc(env(safe-area-inset-bottom) + 84px))' }}
            >
              <div className="bg-kidville-cream rounded-[26px] shadow-2xl border border-black/5 max-h-[70vh] overflow-y-auto p-4">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div>
                    <p className="font-barlow font-bold text-[10px] uppercase tracking-[0.14em] text-kidville-yellow-dark">Tutte le sezioni</p>
                    <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide leading-none">Menu</h3>
                  </div>
                  <button
                    onClick={() => setShowMenu(false)}
                    aria-label="Chiudi"
                    className="w-9 h-9 rounded-full bg-kidville-cream-dark flex items-center justify-center text-kidville-green"
                  >
                    <X className="w-4 h-4" strokeWidth={2.4} />
                  </button>
                </div>

                <div className="flex flex-col gap-[18px]">
                  {groups.map((g) => (
                    <div key={g.label}>
                      <p className="font-barlow font-extrabold text-[11px] uppercase tracking-[0.06em] text-kidville-muted mb-2 pl-1">
                        {g.label}
                      </p>
                      <div
                        className="bg-white rounded-card overflow-hidden"
                        style={{ boxShadow: '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}
                      >
                        {g.items.map((it, i) => {
                          const Icon = it.icon;
                          const active = it.href ? pathname.startsWith(it.href) : false;
                          const borderCls = i < g.items.length - 1 ? 'border-b border-kidville-line' : '';

                          const inner = (
                            <>
                              <span
                                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                                style={{ background: it.tint + '18', color: it.tint }}
                              >
                                <Icon size={21} strokeWidth={1.8} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="font-barlow font-extrabold text-base uppercase leading-none text-kidville-green truncate">
                                    {it.label}
                                  </span>
                                  {it.soon && (
                                    <span className="font-barlow font-bold text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded-pill bg-kidville-neutral-soft text-kidville-muted">
                                      In arrivo
                                    </span>
                                  )}
                                </span>
                                <span className="block font-maven text-xs text-kidville-muted mt-0.5">{it.sub}</span>
                              </span>
                              {it.href && <ChevronRight size={16} className="text-kidville-muted/60 flex-shrink-0" strokeWidth={2} />}
                            </>
                          );

                          if (!it.href) {
                            return (
                              <div
                                key={it.id}
                                aria-disabled="true"
                                className={`flex items-center gap-[13px] px-3 py-[11px] opacity-60 ${borderCls}`}
                              >
                                {inner}
                              </div>
                            );
                          }
                          return (
                            <Link
                              key={it.id}
                              href={withUser(it.href)}
                              onClick={() => setShowMenu(false)}
                              aria-current={active ? 'page' : undefined}
                              className={`flex items-center gap-[13px] px-3 py-[11px] active:bg-kidville-cream ${borderCls}`}
                            >
                              {inner}
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* Accessibilità: il toggle stava solo nella login → irraggiungibile da dentro l'app. */}
                  <ContrastMenuButton
                    iconSize={21}
                    className="flex w-full items-center justify-center gap-2.5 rounded-card bg-white px-3 py-[13px] font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-ink shadow-[0_1px_2px_rgba(0,84,75,.04),0_8px_24px_-18px_rgba(0,84,75,.28)] active:bg-kidville-green-soft"
                  />

                  {/* Uscita — prima non c'era alcun logout nell'area Docente. */}
                  <LogoutMenuButton
                    iconSize={21}
                    className="flex w-full items-center justify-center gap-2.5 rounded-card bg-white px-3 py-[13px] font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-error shadow-[0_1px_2px_rgba(0,84,75,.04),0_8px_24px_-18px_rgba(0,84,75,.28)] active:bg-kidville-error-soft disabled:opacity-60"
                  />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
