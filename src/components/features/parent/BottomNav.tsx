'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import {
  Home, Bell, MessageCircle, BookOpen, MoreHorizontal,
  Image, Package, FileText, BarChart3, CheckSquare, X, Euro, UtensilsCrossed,
  GraduationCap, ClipboardList, AlertTriangle,
} from 'lucide-react';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';

// grado: 'comune' = visibile sempre; 'primaria'/'infanzia' = solo quel grado.
type Grado = 'comune' | 'primaria' | 'infanzia';

const extraAll = [
  { id: 'mensa', label: 'Mensa', icon: UtensilsCrossed, href: '/parent/mensa', grado: 'comune' as Grado },
  { id: 'gallery', label: 'Galleria', icon: Image, href: '/parent/gallery', grado: 'comune' as Grado },
  { id: 'lezioni', label: 'Lezioni', icon: GraduationCap, href: '/parent/lezioni', grado: 'primaria' as Grado },
  { id: 'compiti', label: 'Compiti', icon: ClipboardList, href: '/parent/compiti', grado: 'primaria' as Grado },
  { id: 'note', label: 'Note', icon: AlertTriangle, href: '/parent/primaria/note', grado: 'primaria' as Grado },
  { id: 'assenze', label: 'Assenze', icon: CheckSquare, href: '/parent/primaria/assenze', grado: 'primaria' as Grado },
  { id: 'pagelle', label: 'Pagelle', icon: FileText, href: '/parent/primaria/pagelle', grado: 'primaria' as Grado },
  { id: 'locker', label: 'Armadietto', icon: Package, href: '/parent/locker', grado: 'infanzia' as Grado },
  { id: 'attendance', label: 'Presenze', icon: CheckSquare, href: '/parent/attendance', grado: 'infanzia' as Grado },
  { id: 'modulistica', label: 'Moduli', icon: FileText, href: '/parent/modulistica', grado: 'comune' as Grado },
  { id: 'pagamenti', label: 'Pagamenti', icon: Euro, href: '/parent/pagamenti', grado: 'comune' as Grado },
] as const;

export default function BottomNav() {
  const pathname = usePathname();
  const [showAltro, setShowAltro] = useState(false);
  const { schoolType } = useChildSchoolType();
  const isPrimaria = schoolType === 'primaria';

  // Gating per grado: la primaria non vede le sezioni infanzia e viceversa.
  const visibile = (g: Grado) => g === 'comune' || (isPrimaria ? g === 'primaria' : g === 'infanzia');
  const extraItems = extraAll.filter((i) => visibile(i.grado));

  // 4ª voce della barra: Registro (primaria) o Diario (infanzia/nido).
  const mainTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/parent' as const },
    { id: 'avvisi', label: 'Avvisi', icon: Bell, href: '/parent/avvisi' as const },
    { id: 'chat', label: 'Chat', icon: MessageCircle, href: '/parent/chat' as const },
    isPrimaria
      ? { id: 'scuola', label: 'Scuola', icon: BarChart3, href: '/parent/primaria' as const }
      : { id: 'diario', label: 'Diario', icon: BookOpen, href: '/parent/diary' as const },
    { id: 'altro', label: 'Altro', icon: MoreHorizontal, href: null },
  ] as const;

  const isActive = (href: string) => {
    if (href === '/parent') return pathname === '/parent';
    return pathname.startsWith(href);
  };

  const isAltroSectionActive = extraItems.some(item => pathname.startsWith(item.href));

  return (
    <>
      {/* ── BOTTOM NAV PILL ─────────────────────── */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] z-50 px-3 pb-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="bg-white/96 backdrop-blur-2xl rounded-[26px] shadow-[0_-2px_24px_rgba(0,106,95,0.10),0_8px_32px_rgba(0,0,0,0.08)] border border-white/60">
          <div className="flex items-stretch justify-around px-1 h-[60px]">
            {mainTabs.map((tab) => {
              const Icon = tab.icon;
              const active = tab.href ? isActive(tab.href) : (isAltroSectionActive || showAltro);

              if (tab.id === 'altro') {
                return (
                  <button
                    key="altro"
                    onClick={() => setShowAltro(v => !v)}
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
                  href={tab.href!}
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
          </div>
        </div>
      </div>

      {/* ── ALTRO BOTTOM SHEET ──────────────────── */}
      <AnimatePresence>
        {showAltro && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-kidville-green/30 backdrop-blur-[2px] z-40"
              onClick={() => setShowAltro(false)}
            />

            <motion.div
              key="sheet"
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 380 }}
              className="fixed left-1/2 -translate-x-1/2 w-full max-w-[430px] z-50 px-4"
              style={{ bottom: 'max(84px, calc(env(safe-area-inset-bottom) + 84px))' }}
            >
              <div className="bg-white rounded-[24px] shadow-2xl border border-gray-100/80 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-barlow font-black text-base text-kidville-green uppercase tracking-wide">
                    Tutte le sezioni
                  </h3>
                  <button
                    onClick={() => setShowAltro(false)}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors"
                  >
                    <X className="w-3.5 h-3.5 text-gray-500" />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  {extraItems.map((item) => {
                    const Icon = item.icon;
                    const active = pathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.id}
                        href={item.href}
                        onClick={() => setShowAltro(false)}
                      >
                        <motion.div
                          whileTap={{ scale: 0.94 }}
                          className="flex flex-col items-center gap-2 p-3 rounded-2xl transition-colors"
                          style={{
                            backgroundColor: active ? '#006A5F' : '#FEF1E4',
                          }}
                        >
                          <Icon
                            className="w-5 h-5"
                            style={{ color: active ? '#FDC400' : '#006A5F' }}
                            strokeWidth={1.6}
                          />
                          <span
                            className="text-[10px] font-barlow font-bold uppercase text-center leading-tight"
                            style={{ color: active ? '#FFFFFF' : '#006A5F' }}
                          >
                            {item.label}
                          </span>
                        </motion.div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
