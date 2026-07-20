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
  label: string;
  icon: typeof LayoutDashboard;
  roles?: string[]; // se assente → visibile a tutti i ruoli staff
}

export interface NavGroup {
  title: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ href: '/admin', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Anagrafica',
    items: [{ href: '/admin/students', label: 'Anagrafica', icon: Users }],
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
      { href: '/admin/news', label: 'News', icon: Newspaper },
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
