'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Home, NotebookPen, MessageCircle, BookOpen, LayoutGrid,
  Image, Package, FileText, ClipboardCheck, Users, Megaphone,
  ListTodo, UtensilsCrossed, CalendarDays, User, X, ChevronRight, Newspaper,
} from 'lucide-react';
import { useTeacherIdentity } from '@/lib/auth/use-teacher-identity';
import { useTeacherGradi } from '@/lib/auth/use-teacher-gradi';
import { diarioVisibile, visibileDocente, type GradoVoce } from '@/lib/auth/teacher-gradi';
import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton';
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton';
import { tintaFunzione } from '@/lib/ui/tinte-funzioni';

// ============================================================================
// TeacherBottomNav — bottom bar persistente del design (DR ins/screen-home.jsx
// ShellTabBar + MenuSheet), mirror del pattern Genitore (parent/BottomNav),
// incluso il gating per grado (utenti.gradi via useTeacherGradi): un docente
// solo-primaria non vede le voci 0-6 (Diario/Armadietto) e viceversa.
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
  grado: GradoVoce;
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

export default function TeacherBottomNav() {
  const t = useTranslations('teacherNav');
  const pathname = usePathname();
  const search = useSearchParams();
  const [showMenu, setShowMenu] = useState(false);

  // ── Il foglio si chiude QUANDO la rotta è cambiata, non quando si clicca ──
  // Stesso difetto trovato sulla bottom-nav del genitore e corretto insieme:
  // chiudere il foglio dentro l'`onClick` del `<Link>` smonta il link mentre
  // Next sta portando la navigazione in una transizione React, e se il payload
  // RSC arriva dopo lo smontaggio la navigazione si perde in silenzio. Lo
  // schema era copiato in tutte e due le barre: la regola vive ora in tutte e
  // due, con lo stesso lock a difenderla
  // (`__tests__/ui/bottom-nav-menu-navigazione.test.tsx`).
  const [rottaVista, setRottaVista] = useState(pathname);
  if (rottaVista !== pathname) {
    setRottaVista(pathname);
    setShowMenu(false);
  }
  // Identità a due passaggi (SSR → idratazione): `withUser` omette il parametro
  // finché l'uuid non è risolto, così l'HTML del server e il primo render del
  // client coincidono e nessun href porta mai la stringa «null».
  const { userId, pronta, withUser } = useTeacherIdentity(search);

  // Gradi del docente (utenti.gradi): pilotano quali voci esistono. Finché il
  // dato non è pronto — o per staff senza gradi — non si filtra nulla.
  // `pronta`: senza, il primo passaggio chiederebbe i gradi con identità vuota e
  // il secondo con l'uuid → due GET a /api/primaria/me su ogni pagina docente.
  const tg = useTeacherGradi(userId, pronta);

  // Mondo primaria attivo dal contesto di navigazione (fallback per i misti).
  const isPrimaria = pathname.startsWith('/teacher/primaria');

  // Menu raggruppato del DR (TEACHER_MENU), mappato alle rotte reali.
  const groups: MenuGroup[] = [
    {
      label: t('gruppoInClasse'),
      items: [
        { id: 'appello', label: t('voceAppelloLabel'), sub: t('voceAppelloSub'), icon: ClipboardCheck, href: '/teacher/attendance', tint: tintaFunzione('appello'), grado: 'comune' },
        { id: 'diario', label: t('voceDiarioLabel'), sub: t('voceDiarioSub'), icon: NotebookPen, href: '/teacher/diary', tint: tintaFunzione('diario'), grado: 'infanzia' },
        { id: 'registro', label: t('voceRegistroLabel'), sub: t('voceRegistroSub'), icon: BookOpen, href: '/teacher/primaria', tint: tintaFunzione('registro'), grado: 'primaria' },
        { id: 'presenze', label: t('vocePresenzeLabel'), sub: t('vocePresenzeSub'), icon: Users, href: '/teacher/attendance', tint: tintaFunzione('presenze'), grado: 'comune' },
      ],
    },
    {
      label: t('gruppoVitaScolastica'),
      items: [
        { id: 'mensa', label: t('voceMensaLabel'), sub: t('voceMensaSub'), icon: UtensilsCrossed, href: '/teacher/mensa', tint: tintaFunzione('mensa'), grado: 'comune' },
        { id: 'foto', label: t('voceFotoLabel'), sub: t('voceFotoSub'), icon: Image, href: '/teacher/gallery', tint: tintaFunzione('foto'), grado: 'comune' },
        { id: 'bacheca', label: t('voceBachecaLabel'), sub: t('voceBachecaSub'), icon: Megaphone, href: '/teacher/avvisi', tint: tintaFunzione('bacheca'), grado: 'comune' },
        { id: 'news', label: t('voceNewsLabel'), sub: t('voceNewsSub'), icon: Newspaper, href: '/teacher/news', tint: tintaFunzione('news'), grado: 'comune' },
        { id: 'calendario', label: t('voceCalendarioLabel'), sub: t('voceCalendarioSub'), icon: CalendarDays, href: null, tint: tintaFunzione('calendario'), grado: 'comune', soon: true },
      ],
    },
    {
      label: t('gruppoStrumenti'),
      items: [
        { id: 'attivita', label: t('voceAttivitaLabel'), sub: t('voceAttivitaSub'), icon: ListTodo, href: '/teacher/tasks', tint: tintaFunzione('attivita'), grado: 'comune' },
        { id: 'armadietto', label: t('voceArmadiettoLabel'), sub: t('voceArmadiettoSub'), icon: Package, href: '/teacher/locker', tint: tintaFunzione('armadietto'), grado: 'infanzia' },
        { id: 'moduli', label: t('voceModuliLabel'), sub: t('voceModuliSub'), icon: FileText, href: '/teacher/modulistica', tint: tintaFunzione('moduli'), grado: 'comune' },
        { id: 'messaggi', label: t('voceMessaggiLabel'), sub: t('voceMessaggiSub'), icon: MessageCircle, href: '/teacher/chat', tint: tintaFunzione('messaggi'), grado: 'comune' },
        { id: 'profilo', label: t('voceProfiloLabel'), sub: t('voceProfiloSub'), icon: User, href: null, tint: tintaFunzione('profilo'), grado: 'comune', soon: true },
      ],
    },
  ];

  // Gating per grado (mirror parent/BottomNav): il Diario segue anche
  // l'eccezione E24 (diario 0-6 attivabile per la primaria dall'admin).
  const voceVisibile = (it: MenuItem) =>
    it.id === 'diario' ? diarioVisibile(tg) : visibileDocente(it.grado, tg);
  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter(voceVisibile) }))
    .filter((g) => g.items.length > 0);

  // Tab principali (ordine DR: Dashboard / Diario·Registro / Messaggi / Foto / Menu).
  // Il 2° tab segue i gradi (solo-primaria → Registro, solo-infanzia → Diario);
  // per i misti — o finché il dato non è pronto — resta il contesto di navigazione.
  const secondTab = tg.ready && tg.isPrimariaOnly
    ? { id: 'registro', label: t('voceRegistroLabel'), icon: BookOpen, href: '/teacher/primaria' as const }
    : tg.ready && tg.isInfanziaOnly
      ? { id: 'diario', label: t('voceDiarioLabel'), icon: NotebookPen, href: '/teacher/diary' as const }
      : isPrimaria
        ? { id: 'registro', label: t('voceRegistroLabel'), icon: BookOpen, href: '/teacher/primaria' as const }
        : { id: 'diario', label: t('voceDiarioLabel'), icon: NotebookPen, href: '/teacher/diary' as const };
  const mainTabs = [
    { id: 'home', label: t('tabDashboard'), icon: Home, href: '/teacher' as const },
    secondTab,
    { id: 'messaggi', label: t('tabMessaggi'), icon: MessageCircle, href: '/teacher/chat' as const },
    { id: 'foto', label: t('tabFoto'), icon: Image, href: '/teacher/gallery' as const },
    { id: 'menu', label: t('tabMenu'), icon: LayoutGrid, href: null },
  ] as const;

  const isActive = (href: string) => {
    if (href === '/teacher') return pathname === '/teacher';
    return pathname.startsWith(href);
  };

  const isMenuSectionActive = visibleGroups.some((g) =>
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
          <nav aria-label={t('ariaNavigazionePrincipale')} className="flex items-stretch justify-around px-1 h-[60px]">
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
                  href={withUser(tab.href!)}
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
              className="fixed left-1/2 -translate-x-1/2 w-full max-w-[460px] z-50 px-4"
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
                              href={withUser(it.href)}
                              // Solo sulla rotta corrente: lì nessuna navigazione
                              // avverrebbe, quindi `pathname` non cambierebbe mai e
                              // il foglio resterebbe aperto.
                              onClick={active ? () => setShowMenu(false) : undefined}
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
