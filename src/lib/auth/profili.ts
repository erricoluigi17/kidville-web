import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { areaForRole, type Area } from './active-role'
import type { AppRole } from './require-staff'

/**
 * Profili disponibili per un utente autenticato (M4B) — base dello smistamento
 * per ruolo: un solo link di accesso, poi ognuno atterra sulla propria area.
 *
 * Modello DB (P0/S4 + S6bis): lo staff sta in `utenti` con `utenti.id ==
 * auth.uid()`. Anche i genitori REALI hanno la riga `utenti` (ruolo 'genitore':
 * è l'unica tabella letta da loadAppUser — senza, il login riesce ma le route
 * dati rispondono 401) PIÙ il ponte `parents.auth_user_id == auth.uid()`.
 * Un DOPPIO profilo (es. docente che è anche genitore) è una riga `utenti` con
 * ruolo staff + il ponte genitore sullo stesso auth.uid: qui sotto produce due
 * profili distinti.
 */

export interface Profilo {
  ruolo: AppRole
  area: Area
}

/**
 * Deriva i profili disponibili dall'`auth.uid()` di sessione: riga `utenti`
 * (staff/genitore-demo) + riga `parents` via ponte. Dedup sul ruolo: un
 * genitore-demo in `utenti` che avesse anche il ponte resta UN profilo.
 */
export async function getProfiliForAuthUid(authUid: string): Promise<Profilo[]> {
  const supabase = await createAdminClient()
  const profili: Profilo[] = []

  // NB: un errore DB transiente qui degrada in "meno profili" (fail-closed:
  // al peggio si torna al login) — va comunque a log per l'osservabilità.
  const { data: staff, error: errStaff } = await supabase
    .from('utenti')
    .select('id, role, ruolo')
    .eq('id', authUid)
    .maybeSingle()
  if (errStaff) console.warn('[profili] lettura utenti fallita:', errStaff.message)
  const ruoloStaff = (staff?.role || staff?.ruolo) as AppRole | undefined
  if (ruoloStaff) profili.push({ ruolo: ruoloStaff, area: areaForRole(ruoloStaff) })

  const { data: parent, error: errParent } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authUid)
    .maybeSingle()
  if (errParent) console.warn('[profili] lettura parents fallita:', errParent.message)
  if (parent && !profili.some((p) => p.ruolo === 'genitore')) {
    profili.push({ ruolo: 'genitore', area: 'parent' })
  }

  return profili
}

/**
 * Profili dalla SOLA sessione (cookie Supabase), per route e server component.
 * `null` = anonimo (o fuori da un contesto di richiesta, es. unit test).
 */
export async function getSessionProfili(): Promise<{ authUid: string; profili: Profilo[] } | null> {
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    const authUid = data?.user?.id ?? null
    if (!authUid) return null
    return { authUid, profili: await getProfiliForAuthUid(authUid) }
  } catch {
    return null
  }
}
