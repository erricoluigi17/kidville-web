import {
  LayoutDashboard,
  Users,
  Euro,
  UtensilsCrossed,
  GraduationCap,
  FileText,
  FileSignature,
  Settings,
  Wrench,
  Bell,
  ListTodo,
  Package,
  BookOpen,
  Images,
  Award,
  ShieldCheck,
  CheckSquare,
  ChefHat,
  ShoppingBag,
  MessageCircle,
  Stamp,
  Newspaper,
  Flag,
  ListOrdered,
  Printer,
  UserCheck,
  Handshake,
  NotebookPen,
  MessagesSquare,
  Wallet,
  FolderOpen,
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
 * Mappo SOLO rotte reali (niente nav morte).
 *
 * SETTE VOCI DI PRIMO LIVELLO (decisione del titolare, 2026-10-31). Fino a quel giorno il menu
 * aveva 27 voci in 7 gruppi, 33 righe, e il gruppo «Amministrazione» da solo ne teneva 10
 * scollegate (Contabilità accanto a Moderazione, il CRM accanto alla Privacy): ogni voce nuova
 * finiva dove c'era posto. Oggi sono due link diretti (`title: null`: Home e Anagrafica) e cinque
 * gruppi raggruppati per LAVORO, che sidebar e foglio «Menu» aprono a fisarmonica, uno alla volta
 * (`use-gruppo-aperto.ts`). Contenuto e ordine li fissa `__tests__/ui/admin-nav-config.test.ts`:
 * una voce nuova va nel gruppo del suo lavoro, non in fondo.
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
  /** Chiave i18n del titolo (namespace `etichette`, `navgruppo_<id>`). È anche l'identità del gruppo aperto. */
  titleKey?: string | null;
  /** Icona dell'intestazione del gruppo; assente sui link diretti (`title: null`). */
  icon?: typeof LayoutDashboard;
  items: NavItem[];
}

/** I ruoli che `requireStaff` ammette di default sulle route della coda fatture. */
const RUOLI_CODA_FATTURE: readonly string[] = ['admin', 'coordinator', 'segreteria'];

export const NAV_GROUPS: NavGroup[] = [
  // Home e Anagrafica: link diretti, senza gruppo. Sono le due pagine da cui si parte.
  {
    title: null,
    items: [{ href: '/admin', label: 'Home', labelKey: 'nav_dashboard', icon: LayoutDashboard }],
  },
  {
    title: null,
    items: [{ href: '/admin/students', label: 'Anagrafica', labelKey: 'nav_students', icon: Users }],
  },
  {
    title: 'Registro',
    titleKey: 'navgruppo_registro',
    icon: NotebookPen,
    items: [
      // Appello di TUTTI i gradi: nido e infanzia si compilano qui dentro, la primaria
      // porta al registro della sua classe (che ha una schermata sua, dentro
      // `ClasseShell`). Una voce sola e non due: il menu è un elenco di lavori, non di
      // motori, e «correggere l'appello di una classe» è un lavoro solo.
      //
      // `roles` non è facoltativo. La `cuoca` entra nell'area admin per il solo report
      // cucina, ma `requireDocente` la esclude dalle route delle presenze: vedrebbe una
      // voce che promette l'appello di minori e poi risponde 403. È la stessa ragione,
      // già scritta, della voce «Galleria» in fondo a questo gruppo.
      { href: '/admin/appello', label: 'Appello', labelKey: 'nav_appello', icon: CheckSquare, roles: ['admin', 'coordinator', 'segreteria'] },
      { href: '/admin/diary', label: 'Diario 0–6', labelKey: 'nav_diary', icon: BookOpen },
      { href: '/admin/primaria', label: 'Primaria', labelKey: 'nav_primaria', icon: GraduationCap },
      { href: '/admin/competenze', label: 'Competenze', labelKey: 'nav_competenze', icon: Award },
      // Galleria del PLESSO (segreteria): le foto di tutta la sede, filtrabili per
      // classe, per bambino e per giornata. Sta nel Registro col Diario perché sono i due
      // registri della stessa giornata; `/teacher/gallery` resta la vista di UNA
      // sezione, senza filtro data né filtro bambino. Il gate vero è nelle API
      // (`GET /api/gallery?scope=sede` → `requireStaff`), qui è solo UI.
      // `roles` = gli stessi tre che `requireStaff` ammette di default su quella
      // rotta. Senza, la voce sarebbe visibile anche alla `cuoca`, che entra
      // nell'area admin per il solo report cucina (`AREE_PER_RUOLO`): vedrebbe
      // «Galleria» in sidebar e nel menu, e aprendola atterrerebbe su un 403 —
      // un menu che promette una schermata di foto di minori e poi la nega.
      { href: '/admin/gallery', label: 'Galleria', labelKey: 'nav_gallery', icon: Images, roles: ['admin', 'coordinator', 'segreteria'] },
    ],
  },
  {
    title: 'Comunicazione',
    titleKey: 'navgruppo_comunicazione',
    icon: MessagesSquare,
    items: [
      { href: '/admin/messaggi', label: 'Messaggi', labelKey: 'nav_messaggi', icon: MessageCircle },
      { href: '/admin/avvisi', label: 'Avvisi', labelKey: 'nav_avvisi', icon: Bell },
      { href: '/admin/news', label: 'News', labelKey: 'nav_news', icon: Newspaper },
      { href: '/admin/compiti', label: 'Compiti', labelKey: 'nav_compiti', icon: ListTodo },
      // Moderazione UGC (C5 §2): coda segnalazioni. Riservata alla Direzione
      // (admin/coordinator); il gate vero è nelle API admin/segnalazioni.
      { href: '/admin/moderazione', label: 'Moderazione', labelKey: 'nav_moderazione', icon: Flag, roles: ['admin', 'coordinator'] },
    ],
  },
  {
    title: 'Contabilità e servizi',
    titleKey: 'navgruppo_contabilita_servizi',
    icon: Wallet,
    items: [
      { href: '/admin/pagamenti', label: 'Contabilità', labelKey: 'nav_pagamenti', icon: Euro },
      // Coda fatture (nucleo §4, docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md):
      // sta SOTTO Contabilità nell'elenco, come voce a sé — non una vista interna di
      // `/admin/pagamenti` (ContabilitaNav), perché la coda è tutta-sede e non ha bisogno
      // di `SedeRequired`. `labelKey` punta apposta a una chiave assente da `etichette`
      // (quella voce non esiste, per progetto): l'etichetta VERA vive in
      // `adminContabilita.codaFatture.menu.codaFatture` — le chiavi che questo pannello
      // scrive e che il resto della coda-fatture riusa — e i renderer (`AdminSidebar`,
      // `AdminMenuSheet`) la risolvono con un caso speciale su questo `href`.
      // `roles` = quelli che `requireStaff` ammette di default sulle route della coda: senza,
      // la `cuoca` vedrebbe la voce, aprirebbe un 403 — e il contatore della voce (nucleo §4,
      // `useConteggioCodaFatture`) chiederebbe un 403 a ogni cambio di pagina.
      { href: '/admin/coda-fatture', label: 'Coda fatture', labelKey: 'nav_coda_fatture', icon: ListOrdered, roles: [...RUOLI_CODA_FATTURE] },
      { href: '/admin/mensa', label: 'Mensa', labelKey: 'nav_mensa', icon: UtensilsCrossed },
      { href: '/admin/mensa/cucina', label: 'Report Cucina', labelKey: 'nav_mensa_cucina', icon: ChefHat },
      { href: '/admin/armadietto', label: 'Armadietto', labelKey: 'nav_armadietto', icon: Package },
      { href: '/admin/merchandise', label: 'Merchandise', labelKey: 'nav_merchandise', icon: ShoppingBag },
    ],
  },
  {
    title: 'Segreteria',
    titleKey: 'navgruppo_segreteria',
    icon: FolderOpen,
    items: [
      // CRM della segreteria (`/admin/crm`): le famiglie che chiedono informazioni, le visite in
      // agenda, i richiami da fare. Sta SOPRA Candidature e non sotto: il lock di questo file
      // pretende che Candidature sia subito sopra Modulistica.
      // `roles` = i due che `requireCrm` ammette sulle route `/api/admin/crm/*` (`RUOLI_CRM`,
      // `src/lib/crm/accesso.ts`): la coordinatrice e la `cuoca` vedrebbero una voce che risponde
      // 403. Il gate vero è nelle API, qui è solo UI.
      { href: '/admin/crm', label: 'CRM', labelKey: 'nav_crm', icon: Handshake, roles: ['segreteria', 'admin'] },
      // Candidature «Lavora con noi»: fino al 2026-10-17 erano la quarta linguetta di
      // Modulistica, e il vecchio indirizzo `?tab=candidature` (scritto in ogni
      // notifica `candidatura_ricevuta` già spedita) rimanda qui da `next.config.ts`.
      // `roles` = quelli di `requireStaff` sulla GET dell'elenco: la `cuoca` non vede
      // una voce che le risponderebbe 403.
      { href: '/admin/candidature', label: 'Candidature', labelKey: 'nav_candidature', icon: UserCheck, roles: ['admin', 'coordinator', 'segreteria'] },
      { href: '/admin/modulistica', label: 'Modulistica', labelKey: 'nav_modulistica', icon: FileText },
      // Archivio dei documenti firmati di ogni alunno (moduli, fascicolo,
      // certificati). Il gate dei documenti sanitari è nelle API, non qui.
      { href: '/admin/documenti-firmati', label: 'Documenti firmati', labelKey: 'nav_documenti_firmati', icon: FileSignature },
      // Registro protocolli: riservato ad admin+segreteria (decisione spec
      // 2026-07-12); primo uso reale del campo `roles` (il gate vero è nelle API).
      { href: '/admin/protocolli', label: 'Protocollo', labelKey: 'nav_protocolli', icon: Stamp, roles: ['admin', 'segreteria'] },
      { href: '/admin/storici', label: 'Storici e stampe', labelKey: 'nav_storici', icon: Printer, roles: ['admin', 'coordinator', 'segreteria'] },
    ],
  },
  {
    title: 'Impostazioni',
    titleKey: 'navgruppo_impostazioni',
    icon: Settings,
    items: [
      { href: '/admin/impostazioni', label: 'Impostazioni', labelKey: 'nav_impostazioni', icon: Settings },
      { href: '/admin/tools', label: 'Strumenti', labelKey: 'nav_tools', icon: Wrench },
      { href: '/admin/gdpr', label: 'Privacy & GDPR', labelKey: 'nav_gdpr', icon: ShieldCheck },
    ],
  },
];

// Unico punto che nomina l'href: i renderer (`AdminSidebar`, `AdminMenuSheet`) lo
// confrontano per pescare l'etichetta da `adminContabilita.codaFatture.menu.codaFatture`
// invece che da `etichette` (vedi la nota sulla voce qui sopra), e per affiancarle il
// contatore delle voci attive (`useConteggioCodaFatture`).
export const CODA_FATTURE_HREF = '/admin/coda-fatture';

/** Chi vede la voce «Coda fatture» e ne legge il contatore: i ruoli di `requireStaff`. */
export function puoLeggereCodaFatture(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_CODA_FATTURE.includes(ruolo);
}

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

/**
 * Il gruppo che la fisarmonica apre su questa pagina: il `titleKey` del gruppo con titolo che
 * contiene `current` (l'href già risolto da `activeHref`), oppure `null` per i link diretti, per
 * gli href in `escludi` e per gli href sconosciuti.
 *
 * Cerca su TUTTA la config, senza filtro per ruolo: il ruolo arriva in due tempi (`null` al primo
 * render, come l'SSR, poi quello vero), e il gruppo aperto non deve saltare quando arriva. Il
 * foglio del telefono passa i suoi esclusi (le voci già nei tab in basso): su una pagina-tab non
 * apre nulla, perché la voce accesa è già il tab.
 */
export function gruppoDellaPagina(current: string, escludi?: ReadonlySet<string>): string | null {
  if (escludi?.has(current)) return null;
  const gruppo = NAV_GROUPS.find((g) => g.title !== null && g.items.some((i) => i.href === current));
  return gruppo?.titleKey ?? null;
}

/**
 * La config come la vede questo ruolo: voci filtrate da `visibleItem` e da `escludi`, senza i
 * gruppi rimasti vuoti (un'intestazione che apre il nulla sarebbe un menu che mente).
 */
export function gruppiVisibili(ruolo: string | null | undefined, escludi?: ReadonlySet<string>): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => visibleItem(i, ruolo) && !escludi?.has(i.href)),
  })).filter((g) => g.items.length > 0);
}
