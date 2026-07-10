// Matrice di copertura canonica (route × ruolo) derivata dall'inventario del
// codice: src/app/(dashboard)/{admin,teacher,parent}/**, AdminSidebar,
// TeacherBottomNav, BottomNav genitore. Consumata dalle journey 70/71/72 e dal
// critico di completezza. Le route dinamiche sono istanziate su TEST 1A / Alunno1.
import { SECTION_1A } from './accounts';
import { ALUNNI } from './data';

export interface RouteDef {
  label: string;
  path: string;
  /** true se la route è raggiungibile da voce di menu (non solo link diretto). */
  inNav?: boolean;
  area: string; // gruppo/area funzionale per il report
}

const A1 = ALUNNI[1];
const S = SECTION_1A;

// ── ADMIN / cockpit (Segreteria+Direzione) — desktop ────────────────────────
export const ADMIN_ROUTES: RouteDef[] = [
  { label: 'Dashboard cockpit', path: '/admin', inNav: true, area: 'Dashboard' },
  { label: 'Anagrafica (lista)', path: '/admin/students', inNav: true, area: 'Anagrafica' },
  { label: 'Anagrafica · nuovo alunno', path: '/admin/students/new', area: 'Anagrafica' },
  { label: 'Anagrafica · scheda a tutta area (Alunno1)', path: `/admin/students/${A1}`, area: 'Anagrafica' },
  { label: 'Primaria (hub classi)', path: '/admin/primaria', inNav: true, area: 'Didattica' },
  { label: 'Primaria · classe TEST 1A', path: `/admin/primaria/${S}`, area: 'Didattica' },
  { label: 'Primaria · registro', path: `/admin/primaria/${S}/registro`, area: 'Didattica' },
  { label: 'Primaria · appello', path: `/admin/primaria/${S}/appello`, area: 'Didattica' },
  { label: 'Primaria · valutazioni', path: `/admin/primaria/${S}/valutazioni`, area: 'Didattica' },
  { label: 'Primaria · note', path: `/admin/primaria/${S}/note`, area: 'Didattica' },
  { label: 'Primaria · orario', path: `/admin/primaria/${S}/orario`, area: 'Didattica' },
  { label: 'Primaria · prospetto', path: `/admin/primaria/${S}/prospetto`, area: 'Didattica' },
  { label: 'Primaria · scrutinio', path: `/admin/primaria/${S}/scrutinio`, area: 'Didattica' },
  { label: 'Primaria · fascicolo', path: `/admin/primaria/${S}/fascicolo`, area: 'Didattica' },
  { label: 'Diario 0–6', path: '/admin/diary', inNav: true, area: 'Didattica' },
  { label: 'Competenze', path: '/admin/competenze', inNav: true, area: 'Didattica' },
  { label: 'Armadietto', path: '/admin/armadietto', inNav: true, area: 'Operativo' },
  { label: 'Divise', path: '/admin/divise', inNav: true, area: 'Operativo' },
  { label: 'Mensa', path: '/admin/mensa', inNav: true, area: 'Operativo' },
  { label: 'Report Cucina', path: '/admin/mensa/cucina', inNav: true, area: 'Operativo' },
  { label: 'Pagamenti', path: '/admin/pagamenti', inNav: true, area: 'Amministrazione' },
  { label: 'Modulistica', path: '/admin/modulistica', inNav: true, area: 'Amministrazione' },
  { label: 'Privacy & GDPR', path: '/admin/gdpr', inNav: true, area: 'Amministrazione' },
  { label: 'Messaggi', path: '/admin/messaggi', inNav: true, area: 'Comunicazione' },
  { label: 'Avvisi', path: '/admin/avvisi', inNav: true, area: 'Comunicazione' },
  { label: 'Compiti', path: '/admin/compiti', inNav: true, area: 'Comunicazione' },
  { label: 'Impostazioni', path: '/admin/impostazioni', inNav: true, area: 'Sistema' },
  { label: 'Strumenti', path: '/admin/tools', inNav: true, area: 'Sistema' },
  // Non in sidebar (solo link diretto) — coperti comunque
  { label: 'Iscrizioni', path: '/admin/iscrizioni', area: 'Amministrazione' },
  { label: 'Multi-sede (schools)', path: '/admin/schools', area: 'Sistema' },
  { label: 'SIDI / Piattaforma Unica', path: '/admin/sidi', area: 'Sistema' },
  { label: 'Staff RBAC', path: '/admin/staff', area: 'Sistema' },
  { label: 'Forms · builder', path: '/admin/forms/builder', area: 'Amministrazione' },
  { label: 'Forms · rankings', path: '/admin/forms/rankings', area: 'Amministrazione' },
  { label: 'Forms · submissions', path: '/admin/forms/submissions', area: 'Amministrazione' },
  { label: 'Entry segreteria', path: '/segreteria', area: 'Dashboard' },
];

// ── TEACHER (docente) — mobile ──────────────────────────────────────────────
export const TEACHER_ROUTES: RouteDef[] = [
  { label: 'Dashboard docente', path: '/teacher', inNav: true, area: 'Home' },
  { label: 'Le mie classi (primaria)', path: '/teacher/primaria', inNav: true, area: 'Registro' },
  { label: 'Classe TEST 1A', path: `/teacher/primaria/${S}`, area: 'Registro' },
  { label: 'Classe · registro', path: `/teacher/primaria/${S}/registro`, area: 'Registro' },
  { label: 'Classe · appello', path: `/teacher/primaria/${S}/appello`, area: 'Registro' },
  { label: 'Classe · valutazioni', path: `/teacher/primaria/${S}/valutazioni`, area: 'Registro' },
  { label: 'Classe · note', path: `/teacher/primaria/${S}/note`, area: 'Registro' },
  { label: 'Classe · orario', path: `/teacher/primaria/${S}/orario`, area: 'Registro' },
  { label: 'Classe · prospetto', path: `/teacher/primaria/${S}/prospetto`, area: 'Registro' },
  { label: 'Classe · scrutinio', path: `/teacher/primaria/${S}/scrutinio`, area: 'Registro' },
  { label: 'Classe · fascicolo', path: `/teacher/primaria/${S}/fascicolo`, area: 'Registro' },
  { label: 'Appello', path: '/teacher/attendance', inNav: true, area: 'In classe' },
  { label: 'Diario', path: '/teacher/diary', inNav: true, area: 'In classe' },
  { label: 'Registro (legacy)', path: '/teacher/register', area: 'In classe' },
  { label: 'Attività / compiti', path: '/teacher/tasks', inNav: true, area: 'Strumenti' },
  { label: 'Mensa (read-only)', path: '/teacher/mensa', inNav: true, area: 'Vita scolastica' },
  { label: 'Foto / gallery', path: '/teacher/gallery', inNav: true, area: 'Vita scolastica' },
  { label: 'Bacheca / avvisi', path: '/teacher/avvisi', inNav: true, area: 'Vita scolastica' },
  { label: 'Chat / messaggi', path: '/teacher/chat', inNav: true, area: 'Comunicazione' },
  { label: 'Armadietto', path: '/teacher/locker', inNav: true, area: 'Strumenti' },
  { label: 'Modulistica', path: '/teacher/modulistica', inNav: true, area: 'Strumenti' },
  { label: 'Impostazioni armadietto', path: '/teacher/settings/locker', area: 'Strumenti' },
];

// ── PARENT (genitore) — mobile ──────────────────────────────────────────────
export const PARENT_ROUTES: RouteDef[] = [
  { label: 'Home genitore', path: '/parent', inNav: true, area: 'Home' },
  { label: 'Scuola/Registro (primaria)', path: '/parent/primaria', inNav: true, area: 'Didattica' },
  { label: 'Valutazioni', path: '/parent/primaria/valutazioni', inNav: true, area: 'Didattica' },
  { label: 'Note', path: '/parent/primaria/note', inNav: true, area: 'Didattica' },
  { label: 'Orario', path: '/parent/primaria/orario', inNav: true, area: 'Didattica' },
  { label: 'Assenze', path: '/parent/primaria/assenze', inNav: true, area: 'La giornata' },
  { label: 'Pagelle', path: '/parent/primaria/pagelle', inNav: true, area: 'Didattica' },
  { label: 'Lezioni', path: '/parent/lezioni', inNav: true, area: 'Didattica' },
  { label: 'Compiti', path: '/parent/compiti', inNav: true, area: 'Didattica' },
  { label: 'Presenze (infanzia)', path: '/parent/attendance', area: 'La giornata' },
  { label: 'Diario', path: '/parent/diary', area: 'La giornata' },
  { label: 'Foto e video', path: '/parent/gallery', inNav: true, area: 'La giornata' },
  { label: 'Mensa', path: '/parent/mensa', inNav: true, area: 'Servizi' },
  { label: 'Divise', path: '/parent/divise', inNav: true, area: 'Servizi' },
  { label: 'Armadietto', path: '/parent/locker', area: 'Servizi' },
  { label: 'Pagamenti', path: '/parent/pagamenti', inNav: true, area: 'Servizi' },
  { label: 'Avvisi', path: '/parent/avvisi', inNav: true, area: 'Comunicazioni' },
  { label: 'Chat', path: '/parent/chat', inNav: true, area: 'Comunicazioni' },
  { label: 'Modulistica', path: '/parent/modulistica', inNav: true, area: 'Documenti' },
  { label: 'Onboarding', path: '/parent/onboarding', area: 'Documenti' },
];

export const MATRIX = {
  admin: ADMIN_ROUTES,
  teacher: TEACHER_ROUTES,
  parent: PARENT_ROUTES,
};
