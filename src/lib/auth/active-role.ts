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
 * Matrice ruolo → aree, in UN posto solo. Eccezione preservata: lo staff di
 * gestione (admin/coordinator/segreteria) può aprire anche `/teacher` — ha già
 * permessi di scrittura sulle funzioni docente lato API (requireDocente).
 *
 * Fail-closed sul ruolo ignoto: nessuna area. Non è simmetrico ad `areaForRole`,
 * che invece un ripiego ce l'ha (`parent`) perché deve pur mandare qualcuno da
 * qualche parte — e la discrepanza è VOLUTA: è ciò che l'anti-loop di
 * `decideAreaAccess` gestisce (home di ripiego `/parent` + nessuna area ammessa).
 */
const AREE_PER_RUOLO: Record<AppRole, readonly Area[]> = {
  admin: ['admin', 'teacher'],
  coordinator: ['admin', 'teacher'],
  segreteria: ['admin', 'teacher'],
  cuoca: ['admin'],
  educator: ['teacher'],
  genitore: ['parent'],
}

/** Le aree che un ruolo può aprire. Fonte unica: `isAreaAllowed` ne è la derivata. */
export function areeDelRuolo(ruolo: string): readonly Area[] {
  return AREE_PER_RUOLO[ruolo as AppRole] ?? []
}

/**
 * Matrice di accesso ruolo-ATTIVO → area.
 *
 * Prende il ruolo attivo e non un insieme, ed è giusto così: questa è la matrice
 * della PRESENTAZIONE — «la veste che indosso adesso può guardare questa area?».
 * L'autorizzazione vera (i ruoli reali del database) sta nei gate API, non qui.
 */
export function isAreaAllowed(ruoloAttivo: string, area: Area): boolean {
  return areeDelRuolo(ruoloAttivo).includes(area)
}

/**
 * La forma minima di un profilo che serve a questo modulo: il solo ruolo.
 *
 * STRUTTURALE e non `import { Profilo } from './profili'`, perché quel modulo tira
 * dentro il client Supabase e QUESTO file lo carica anche la pagina di login, che
 * gira nel browser. La testata dice «nessun import server»: un `import type` sarebbe
 * erased dal compilatore, ma basterebbe che un domani qualcuno tolga il `type` per
 * trascinare `@supabase/*` in un bundle client senza che niente diventi rosso.
 */
export interface ConRuolo {
  ruolo: string
}

/** L'unione delle aree di più profili, senza doppioni e nell'ordine in cui compaiono. */
export function areeDeiProfili(profili: readonly ConRuolo[]): readonly Area[] {
  const out: Area[] = []
  for (const p of profili) {
    for (const a of areeDelRuolo(p.ruolo)) if (!out.includes(a)) out.push(a)
  }
  return out
}

/**
 * Il ruolo ATTIVO: quale delle proprie viste legittime si sta guardando.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────
 * Questa risoluzione stava scritta DUE volte in `area-guard.ts` (righe 35-40 e
 * 67-72), identica carattere per carattere. Due copie della stessa decisione
 * divergono al primo ritocco, e qui la decisione è di sicurezza.
 *
 * ─── LA REGOLA ─────────────────────────────────────────────────────────────
 * Il cookie non concede e non revoca niente: vale solo se nomina un ruolo che la
 * persona HA DAVVERO. Se non lo fa (cookie assente, cookie estraneo, ruolo
 * inventato, ruolo REVOCATO nel frattempo) si ricade sul profilo unico — e se i
 * profili sono due, il risultato è `null`: AMBIGUO. Chi chiama decide cosa fare
 * dell'ambiguità: la guardia d'area manda a scegliere, i gate API ricadono su
 * `utenti.ruolo`. Ciò che nessuno dei due fa è tirare a indovinare.
 *
 * `parseActiveRole` PRIMA del confronto: il cookie è input del client e passa da
 * una lista chiusa, non da un `===` su una stringa arbitraria.
 */
export function risolviRuoloAttivo(
  profili: readonly ConRuolo[] | null | undefined,
  cookieRuolo: string | null | undefined,
): AppRole | null {
  if (!profili || profili.length === 0) return null
  const scelto = parseActiveRole(cookieRuolo)
  if (scelto && profili.some((p) => p.ruolo === scelto)) return scelto
  // Ripiego: se la vista è una sola non c'è niente da scegliere. Il cast regge anche
  // un ruolo legacy fuori matrice (`maestra` in `utenti`): non è un `AppRole` valido,
  // ma è il ruolo VERO di quella persona e va restituito, non nascosto.
  return profili.length === 1 ? (profili[0].ruolo as AppRole) : null
}

/** Valida il valore del cookie `kv-active-role`: solo ruoli noti, altrimenti `null`. */
export function parseActiveRole(value: string | null | undefined): AppRole | null {
  return value && (RUOLI_APP as string[]).includes(value) ? (value as AppRole) : null
}

/**
 * Legge un cookie dall'intestazione `Cookie` grezza. PURA: nessun `next/headers`.
 *
 * ─── PERCHÉ NON `cookies()` ────────────────────────────────────────────────
 * `cookies()` LANCIA fuori da un contesto di richiesta, e i ~90 test API di questo
 * repo invocano gli handler con una `Request` nuda. Un `require-staff.ts` che
 * importasse `next/headers` avrebbe bisogno di un `try/catch` obbligato PER
 * COSTRUZIONE — cioè un catch che inghiotte sempre, che è esattamente il difetto
 * vietato da AGENTS.md regola 6. Con l'intestazione la funzione è pura e testabile,
 * cosa che `area-guard.ts:86` oggi non è.
 *
 * Confronto sul NOME ESATTO, non `includes`: `x-kv-active-role` e `kv-active-role-2`
 * non sono `kv-active-role`, e prendere il valore sbagliato qui significa prendere
 * il RUOLO sbagliato.
 *
 * Niente `decodeURIComponent`, e niente try/catch che lo protegga: gli unici valori
 * che questo repo mette in questo cookie sono i sei nomi di `RUOLI_APP`, che non
 * hanno caratteri da codificare — e a valle passano comunque da `parseActiveRole`,
 * che è a lista chiusa. Un decode qui aggiungerebbe solo un `catch` da giustificare.
 */
export function leggiCookie(intestazione: string | null | undefined, nome: string): string | null {
  if (!intestazione) return null
  for (const pezzo of intestazione.split(';')) {
    const sep = pezzo.indexOf('=')
    if (sep < 0) continue
    if (pezzo.slice(0, sep).trim() !== nome) continue
    return pezzo.slice(sep + 1).trim()
  }
  return null
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
