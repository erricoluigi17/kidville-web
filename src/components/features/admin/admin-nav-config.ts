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
  Newspaper,
} from 'lucide-react';

/**
 * Config nav condivisa del cockpit Direzione/Segreteria.
 *
 * Sorgente UNICA per le tre superfici di navigazione admin: sidebar desktop
 * (`AdminSidebar`), bottom-nav mobile (`AdminBottomNav`) e bottom-sheet «Menu»
 * (`AdminMenuSheet`). Estratta da `AdminSidebar.tsx` mantenendo la stessa
 * semantica del vecchio `visible` (ora `visibleItem`) e dello stesso
 * `activeHref` (match più lungo). Nessuna logica nuova: solo un punto solo.
 *
 * Il ruolo determina (a) lo scope dati a livello API e (b) — via `roles` —
 * l'eventuale visibilità delle voci. Il gate VERO è nelle API: qui è solo UI.
 * Gruppi come nel design cockpit (DR segreteria-direzione): raggruppo per area.
 * Mappo SOLO rotte reali (niente nav morte).
 */

export interface NavItem {
  href: string;
  /** Etichetta IT — fallback se la chiave i18n manca (namespace `etichette`). */
  label: string;
  /** Chiave i18n della label (namespace `etichette`, `nav_<id>`). */
  labelKey: string;
  icon: typeof LayoutDashboard;
  roles?: string[]; // se assente → visibile a tutti i ruoli staff
}

export interface NavGroup {
  /** Titolo IT — fallback se la chiave i18n manca. */
  title: string | null;
  /** Chiave i18n del titolo (namespace `etichette`, `navgruppo_<id>`). */
  titleKey?: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ href: '/admin', label: 'Dashboard', labelKey: 'nav_dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Anagrafica',
    titleKey: 'navgruppo_anagrafica',
    items: [{ href: '/admin/students', label: 'Anagrafica', labelKey: 'nav_students', icon: Users }],
  },
  {
    title: 'Didattica',
    titleKey: 'navgruppo_didattica',
    items: [
      { href: '/admin/primaria', label: 'Primaria', labelKey: 'nav_primaria', icon: GraduationCap },
      { href: '/admin/diary', label: 'Diario 0–6', labelKey: 'nav_diary', icon: BookOpen },
      { href: '/admin/competenze', label: 'Competenze', labelKey: 'nav_competenze', icon: Award },
    ],
  },
  {
    title: 'Operativo',
    titleKey: 'navgruppo_operativo',
    items: [
      { href: '/admin/armadietto', label: 'Armadietto', labelKey: 'nav_armadietto', icon: Package },
      { href: '/admin/merchandise', label: 'Merchandise', labelKey: 'nav_merchandise', icon: ShoppingBag },
      { href: '/admin/mensa', label: 'Mensa', labelKey: 'nav_mensa', icon: UtensilsCrossed },
      { href: '/admin/mensa/cucina', label: 'Report Cucina', labelKey: 'nav_mensa_cucina', icon: ChefHat },
    ],
  },
  {
    title: 'Amministrazione',
    titleKey: 'navgruppo_amministrazione',
    items: [
      { href: '/admin/pagamenti', label: 'Contabilità', labelKey: 'nav_pagamenti', icon: Euro },
      // Registro protocolli: riservato ad admin+segreteria (decisione spec
      // 2026-07-12); primo uso reale del campo `roles` (il gate vero è nelle API).
      { href: '/admin/protocolli', label: 'Protocollo', labelKey: 'nav_protocolli', icon: Stamp, roles: ['admin', 'segreteria'] },
      { href: '/admin/modulistica', label: 'Modulistica', labelKey: 'nav_modulistica', icon: FileText },
      { href: '/admin/gdpr', label: 'Privacy & GDPR', labelKey: 'nav_gdpr', icon: ShieldCheck },
    ],
  },
  {
    title: 'Comunicazione',
    titleKey: 'navgruppo_comunicazione',
    items: [
      { href: '/admin/messaggi', label: 'Messaggi', labelKey: 'nav_messaggi', icon: MessageCircle },
      { href: '/admin/avvisi', label: 'Avvisi', labelKey: 'nav_avvisi', icon: Bell },
      { href: '/admin/news', label: 'News', labelKey: 'nav_news', icon: Newspaper },
      { href: '/admin/compiti', label: 'Compiti', labelKey: 'nav_compiti', icon: ListTodo },
    ],
  },
  {
    title: 'Sistema',
    titleKey: 'navgruppo_sistema',
    items: [
      { href: '/admin/impostazioni', label: 'Impostazioni', labelKey: 'nav_impostazioni', icon: Settings },
      { href: '/admin/tools', label: 'Strumenti', labelKey: 'nav_tools', icon: Wrench },
    ],
  },
];

export const ALL_HREFS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));

// href attivo = il match più SPECIFICO (più lungo), così su /admin/mensa/cucina
// si evidenzia "Report Cucina" e non anche "Mensa". '/admin' resta esatto.
export function activeHref(pathname: string): string {
  let best = '';
  for (const href of ALL_HREFS) {
    const match =
      href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(href + '/');
    if (match && href.length > best.length) best = href;
  }
  return best;
}

// Visibilità di una voce per il ruolo corrente — semantica identica al vecchio
// `visible` della sidebar: niente `roles` → sempre visibile; con `roles` →
// visibile solo se il ruolo è noto ed è nella lista.
export function visibleItem(item: NavItem, ruolo: string | null | undefined): boolean {
  return !item.roles || (!!ruolo && item.roles.includes(ruolo));
}
