import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  ACTIVE_ROLE_COOKIE,
  homePathForRole,
  isAreaAllowed,
  parseActiveRole,
  type Area,
} from './active-role'
import { getSessionProfili, type Profilo } from './profili'

/**
 * Guardia d'area server-side (M4B.4), montata nei layout di `/parent`,
 * `/teacher`, `/admin`: risolve sessione + ruolo attivo e reindirizza chi apre
 * un'area non coerente col proprio ruolo (docente su /parent → /teacher).
 */

/**
 * Decisione PURA: profili disponibili + cookie ruolo attivo + area richiesta →
 * `null` (accesso ok) oppure il path di redirect.
 * - anonimo/non collegato → login (il middleware già copre l'anonimo: qui è
 *   difesa in profondità);
 * - cookie valido solo se il ruolo appartiene davvero ai profili (un cookie
 *   estraneo viene ignorato); fallback: ruolo unico;
 * - doppio profilo senza ruolo attivo → login per la scelta (`?scegli=1`);
 * - ruolo attivo non ammesso nell'area → home del ruolo.
 */
export function decideAreaAccess(
  profili: Profilo[] | null,
  cookieRuolo: string | null,
  area: Area
): string | null {
  if (!profili || profili.length === 0) return '/auth/login'

  const ruoloAttivo =
    cookieRuolo && profili.some((p) => p.ruolo === cookieRuolo)
      ? cookieRuolo
      : profili.length === 1
        ? profili[0].ruolo
        : null

  if (!ruoloAttivo) return `/auth/login?scegli=1&next=/${area}`
  if (!isAreaAllowed(ruoloAttivo, area)) {
    const home = homePathForRole(ruoloAttivo)
    // Anti-loop: un ruolo fuori matrice (es. legacy in `utenti`) ha home di
    // fallback /parent ma nessuna area ammessa — reindirizzarlo alla stessa
    // area che sta guardando sarebbe un giro infinito.
    return home === `/${area}` ? '/auth/login' : home
  }
  return null
}

/**
 * Decisione PURA per la radice `/`: dove atterra chi apre l'app dalla home.
 * È lo stesso smistamento della guardia d'area ma SENZA un'area di destinazione:
 * si va sempre alla home del proprio ruolo (o al login).
 *  - anonimo/nessun profilo → login;
 *  - ruolo attivo risolto (cookie valido, oppure profilo unico) → home del ruolo;
 *  - doppio profilo senza ruolo attivo → login con scelta ruolo (`?scegli=1`).
 */
export function decideRootLanding(
  profili: Profilo[] | null,
  cookieRuolo: string | null
): string {
  if (!profili || profili.length === 0) return '/auth/login'

  const ruoloAttivo =
    cookieRuolo && profili.some((p) => p.ruolo === cookieRuolo)
      ? cookieRuolo
      : profili.length === 1
        ? profili[0].ruolo
        : null

  if (!ruoloAttivo) return '/auth/login?scegli=1'
  return homePathForRole(ruoloAttivo)
}

/**
 * Wrapper server per i layout: `await requireArea('parent')`.
 * NB: `cookies()` è chiamata PRIMA e FUORI da try/catch — in build l'errore di
 * bailout deve propagarsi (la rotta diventa dynamic, niente redirect "cotto"
 * nello statico); idem `redirect()` (NEXT_REDIRECT è control-flow di Next).
 */
export async function requireArea(area: Area): Promise<void> {
  const cookieStore = await cookies()
  const cookieRuolo = parseActiveRole(cookieStore.get(ACTIVE_ROLE_COOKIE)?.value)
  const sessione = await getSessionProfili()
  const dest = decideAreaAccess(sessione?.profili ?? null, cookieRuolo, area)
  if (dest) redirect(dest)
}
