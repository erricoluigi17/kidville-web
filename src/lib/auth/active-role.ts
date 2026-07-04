import type { AppRole } from './require-staff'

/**
 * Regole PURE dello smistamento per ruolo (M4B.2) — nessun import server:
 * il modulo è usato sia dai layout/route (server) sia dalla pagina di login
 * (client). Il ruolo ATTIVO di chi ha più profili vive nel cookie
 * `kv-active-role`: lo SETTA server-side `POST /api/auth/active-role`
 * (validando che il ruolo appartenga davvero all'utente) e lo LEGGONO
 * server-side le guardie d'area nei layout, via `parseActiveRole()`.
 */

/** Aree di navigazione dell'app: prefissi rotta `/admin`, `/teacher`, `/parent`. */
export type Area = 'admin' | 'teacher' | 'parent'

export const ACTIVE_ROLE_COOKIE = 'kv-active-role'

export const RUOLI_APP: AppRole[] = ['admin', 'coordinator', 'segreteria', 'cuoca', 'educator', 'genitore']

// Area "casa" di ogni ruolo. La cuoca vive sotto /admin (report cucina in
// /admin/mensa/cucina, gate API requireKitchenRead).
const AREA_BY_ROLE: Record<AppRole, Area> = {
  admin: 'admin',
  coordinator: 'admin',
  segreteria: 'admin',
  cuoca: 'admin',
  educator: 'teacher',
  genitore: 'parent',
}

/** Area di atterraggio del ruolo; ruolo ignoto → `parent` (area meno privilegiata). */
export function areaForRole(ruolo: string): Area {
  return AREA_BY_ROLE[ruolo as AppRole] ?? 'parent'
}

/**
 * Matrice di accesso ruolo-attivo → area. Eccezione preservata: lo staff di
 * gestione (admin/coordinator/segreteria) può aprire anche `/teacher` — ha già
 * permessi di scrittura sulle funzioni docente lato API (requireDocente).
 */
export function isAreaAllowed(ruoloAttivo: string, area: Area): boolean {
  switch (ruoloAttivo as AppRole) {
    case 'admin':
    case 'coordinator':
    case 'segreteria':
      return area === 'admin' || area === 'teacher'
    case 'cuoca':
      return area === 'admin'
    case 'educator':
      return area === 'teacher'
    case 'genitore':
      return area === 'parent'
    default:
      return false
  }
}

/** Valida il valore del cookie `kv-active-role`: solo ruoli noti, altrimenti `null`. */
export function parseActiveRole(value: string | null | undefined): AppRole | null {
  return value && (RUOLI_APP as string[]).includes(value) ? (value as AppRole) : null
}

/** Area di un pathname (`/teacher/registro` → `teacher`); `null` se fuori dalle aree. */
export function areaFromPath(pathname: string): Area | null {
  for (const area of ['admin', 'teacher', 'parent'] as const) {
    if (pathname === `/${area}` || pathname.startsWith(`/${area}/`)) return area
  }
  return null
}

/** Home dell'area: `/admin` | `/teacher` | `/parent`. */
export function homePathForArea(area: Area): string {
  return `/${area}`
}

/** Home del ruolo: dove atterra dopo il login (genitore→/parent, educator→/teacher, staff→/admin). */
export function homePathForRole(ruolo: string): string {
  return homePathForArea(areaForRole(ruolo))
}
