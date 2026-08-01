'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Home, Bell, MessageCircle, BookOpen, LayoutGrid,
  Image, Package, FileText, BarChart3, X, Euro, UtensilsCrossed,
  GraduationCap, ClipboardList, AlertTriangle, Megaphone, CalendarX2, IdCard,
  ChevronRight, Newspaper,
} from 'lucide-react';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';

// grado: 'comune' = visibile sempre; 'primaria'/'infanzia' = solo quel grado.
type Grado = 'comune' | 'primaria' | 'infanzia';

interface MenuItem {
  id: string;
  label: string;
  sub: string;
  icon: typeof Home;
  href: string | null; // null = funzione non ancora navigabile
  tint: string;
  grado: Grado;
  soon?: boolean;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

// ── Barra principale: colori SOLO via token ─────────────────────────────────
// Qui i colori erano tre hex scritti a mano dentro `style={{ }}`: fuori dai
// token, quindi irraggiungibili da qualunque correzione centrale — e il grigio
// delle voci INATTIVE (#9CA3AF) si fermava a 2,54:1 sul bianco della pillola,
// cioè 4 voci su 5 della navigazione principale del telefono sotto AA.
// `text-kidville-sub` vale 6,46:1. Il fondo del pill attivo lascia
// `animate={{ backgroundColor }}` e diventa una classe: la molla resta sulla
// scala, il colore lo fa il token (stesso schema di `AdminBottomNav`).
const PILL = 'w-10 h-[30px] rounded-full flex items-center justify-center transition-colors duration-200';
const ICONA = 'w-[18px] h-[18px] transition-colors duration-200';
const ETICHETTA = 'text-[9px] font-barlow font-bold uppercase tracking-wider transition-colors duration-200';

export default function BottomNav() {
  const pathname = usePathname();
  const [showMenu, setShowMenu] = useState(false);
  const { schoolType } = useChildSchoolType();
  const isPrimaria = schoolType === 'primaria';
  // Testi della navigazione dal namespace i18n «nav» (label tab, gruppi e voci
  // del menu, aria-label). I dati (rotte, tint, icone) restano nel codice.
  const t = useTranslations('nav');

  const visibile = (g: Grado) => g === 'comune' || (isPrimaria ? g === 'primaria' : g === 'infanzia');

  // Menu raggruppato del design (DR app/modules MenuScreen), mappato alle rotte reali.
  // "Profilo e deleghe" non ha rotta reale → reso non navigabile con badge "In arrivo"
  // (gap segnalato nel piano). I badge "In arrivo" del mockup sono stati RIMOSSI dalle
  // voci già funzionanti (Registro/Mensa/Pagamenti/Modulistica esistono).
  const groups: MenuGroup[] = [
    {
      label: t('gruppoLaGiornata'),
      items: [
        { id: 'diario', label: t('voceDiarioLabel'), sub: t('voceDiarioSub'), icon: BookOpen, href: '/parent/diary', tint: '#006A5F', grado: 'infanzia' },
        { id: 'presenze', label: t('vocePresenzeLabel'), sub: t('vocePresenzeSub'), icon: CalendarX2, href: isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance', tint: '#E6720A', grado: 'comune' },
        { id: 'foto', label: t('voceFotoLabel'), sub: t('voceFotoSub'), icon: Image, href: '/parent/gallery', tint: '#D14D8A', grado: 'comune' },
      ],
    },
    {
      label: t('gruppoDidatticaPrimaria'),
      items: [
        { id: 'registro', label: t('voceRegistroLabel'), sub: t('voceRegistroSub'), icon: BarChart3, href: '/parent/primaria', tint: '#2A6FDB', grado: 'primaria' },
        { id: 'lezioni', label: t('voceLezioniLabel'), sub: t('voceLezioniSub'), icon: GraduationCap, href: '/parent/lezioni', tint: '#0E9488', grado: 'primaria' },
        { id: 'compiti', label: t('voceCompitiLabel'), sub: t('voceCompitiSub'), icon: ClipboardList, href: '/parent/compiti', tint: '#E6720A', grado: 'primaria' },
        { id: 'note', label: t('voceNoteLabel'), sub: t('voceNoteSub'), icon: AlertTriangle, href: '/parent/primaria/note', tint: '#B5651D', grado: 'primaria' },
        { id: 'pagelle', label: t('vocePagelleLabel'), sub: t('vocePagelleSub'), icon: FileText, href: '/parent/primaria/pagelle', tint: '#2A6FDB', grado: 'primaria' },
      ],
    },
    {
      label: t('gruppoServizi'),
      items: [
        { id: 'mensa', label: t('voceMensaLabel'), sub: t('voceMensaSub'), icon: UtensilsCrossed, href: '/parent/mensa', tint: '#1F8A5B', grado: 'comune' },
        { id: 'armadietto', label: t('voceArmadiettoLabel'), sub: t('voceArmadiettoSub'), icon: Package, href: '/parent/locker', tint: '#C9971A', grado: 'infanzia' },
        { id: 'pagamenti', label: t('vocePagamentiLabel'), sub: t('vocePagamentiSub'), icon: Euro, href: '/parent/pagamenti', tint: '#7A3FD0', grado: 'comune' },
      ],
    },
    {
      label: t('gruppoComunicazioni'),
      items: [
        { id: 'avvisi', label: t('voceAvvisiLabel'), sub: t('voceAvvisiSub'), icon: Megaphone, href: '/parent/avvisi', tint: '#006A5F', grado: 'comune' },
        { id: 'news', label: t('voceNewsLabel'), sub: t('voceNewsSub'), icon: Newspaper, href: '/parent/news', tint: '#D14D8A', grado: 'comune' },
        { id: 'chat', label: t('voceChatLabel'), sub: t('voceChatSub'), icon: MessageCircle, href: '/parent/chat', tint: '#2A6FDB', grado: 'comune' },
      ],
    },
    {
      label: t('gruppoDocumenti'),
      items: [
        { id: 'modulistica', label: t('voceModulisticaLabel'), sub: t('voceModulisticaSub'), icon: FileText, href: '/parent/modulistica', tint: '#B5651D', grado: 'comune' },
        { id: 'profilo', label: t('voceProfiloLabel'), sub: t('voceProfiloSub'), icon: IdCard, href: '/parent/profilo', tint: '#475569', grado: 'comune' },
      ],
    },
  ];

  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => visibile(i.grado)) }))
    .filter((g) => g.items.length > 0);

  // Tab principali (ordine DR: Home / Diario·Scuola / Avvisi / Chat / Menu).
  const mainTabs = [
    { id: 'home', label: t('tabHome'), icon: Home, href: '/parent' as const },
    isPrimaria
      ? { id: 'scuola', label: t('tabScuola'), icon: BarChart3, href: '/parent/primaria' as const }
      : { id: 'diario', label: t('tabDiario'), icon: BookOpen, href: '/parent/diary' as const },
    { id: 'avvisi', label: t('tabAvvisi'), icon: Bell, href: '/parent/avvisi' as const },
    { id: 'chat', label: t('tabChat'), icon: MessageCircle, href: '/parent/chat' as const },
    { id: 'menu', label: t('tabMenu'), icon: LayoutGrid, href: null },
  ] as const;

  const isActive = (href: string) => {
    if (href === '/parent') return pathname === '/parent';
    return pathname.startsWith(href);
  };

  const isMenuSectionActive = visibleGroups.some((g) =>
    g.items.some((i) => i.href && pathname.startsWith(i.href)),
  );
  // Mutua esclusività: il MENU non si accende sulle rotte già coperte da un tab
  // dedicato (Home/Scuola·Diario/Avvisi/Chat) → una sola voce attiva.
  const anyMainTabActive = mainTabs.some((tab) => tab.href && isActive(tab.href));

  return (
    <>
      {/* ── BOTTOM NAV PILL ─────────────────────── */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] z-50 px-3 pb-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="bg-white/96 backdrop-blur-2xl rounded-[26px] shadow-[0_-2px_24px_rgba(0,106,95,0.10),0_8px_32px_rgba(0,0,0,0.08)] border border-white/60">
          <nav aria-label={t('ariaNavigazionePrincipale')} className="flex items-stretch justify-around px-1 h-[60px]">
            {mainTabs.map((tab) => {
              const Icon = tab.icon;
              const active = tab.href ? isActive(tab.href) : ((isMenuSectionActive && !anyMainTabActive) || showMenu);

              if (tab.id === 'menu') {
                return (
                  <button
                    key="menu"
                    onClick={() => setShowMenu(v => !v)}
                    aria-haspopup="menu"
                    aria-expanded={showMenu}
                    aria-label={t('ariaMenu')}
                    className="flex flex-col items-center justify-center gap-[3px] flex-1 py-1 relative"
                  >
                    <motion.div
                      animate={{ scale: active ? 1.05 : 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      className={`${PILL} ${active ? 'bg-kidville-green' : ''}`}
                    >
                      <Icon
                        className={`${ICONA} ${active ? 'text-kidville-yellow' : 'text-kidville-sub'}`}
                        strokeWidth={2}
                      />
                    </motion.div>
                    <span className={`${ETICHETTA} ${active ? 'text-kidville-green' : 'text-kidville-sub'}`}>
                      {tab.label}
                    </span>
                  </button>
                );
              }

              return (
                <Link
                  key={tab.id}
                  href={tab.href!}
                  aria-current={active ? 'page' : undefined}
                  className="flex flex-col items-center justify-center gap-[3px] flex-1 py-1 relative"
                >
                  <motion.div
                    animate={{ scale: active ? 1.05 : 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className={`${PILL} ${active ? 'bg-kidville-green' : ''}`}
                  >
                    <Icon
                      className={`${ICONA} ${active ? 'text-kidville-yellow' : 'text-kidville-sub'}`}
                      strokeWidth={2}
                    />
                  </motion.div>
                  <span className={`${ETICHETTA} ${active ? 'text-kidville-green' : 'text-kidville-sub'}`}>
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
              className="fixed left-1/2 -translate-x-1/2 w-full max-w-[430px] z-50 px-4"
              style={{ bottom: 'max(84px, calc(env(safe-area-inset-bottom) + 84px))' }}
            >
              <div className="bg-kidville-cream rounded-[26px] shadow-2xl border border-black/5 max-h-[70vh] overflow-y-auto p-4">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div>
                    <p className="font-barlow font-bold text-[10px] uppercase tracking-[0.14em] text-kidville-yellow-dark">{t('menuEyebrow')}</p>
                    <h3 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide leading-none">{t('menuTitolo')}</h3>
                  </div>
                  <button
                    onClick={() => setShowMenu(false)}
                    aria-label={t('ariaChiudi')}
                    className="w-9 h-9 rounded-full bg-kidville-cream-dark flex items-center justify-center text-kidville-green"
                  >
                    <X className="w-4 h-4" strokeWidth={2.4} />
                  </button>
                </div>

                <div className="flex flex-col gap-[18px]">
                  {visibleGroups.map((g) => (
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
                                      {t('badgeInArrivo')}
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
                              href={it.href}
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

                  {/* Uscita — prima non c'era alcun logout nell'area Genitore. */}
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
