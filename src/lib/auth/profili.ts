import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { areaForRole, type Area } from './active-role'
import { profiloStaffRevocato } from './predicati-ruolo'
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
  // ⚠️ `archiviato_il` sta nella select, e la select degrada: PostgREST, su una
  // colonna assente, fallisce la query INTERA con `42703`. Finché la migrazione
  // non è applicata — il DB E2E della CI, e la produzione fra il deploy e il
  // merge — chiedere quel campo senza ripiego toglierebbe i profili a TUTTI.
  let { data: staff, error: errStaff } = await supabase
    .from('utenti')
    .select('id, role, ruolo, archiviato_il')
    .eq('id', authUid)
    .maybeSingle()
  if (errStaff && schemaAssente(errStaff)) {
    logEvento('auth', 'warn', {
      operazione: 'getProfiliForAuthUid',
      esito: 'archiviazione-non-verificabile',
      error_code: (errStaff as { code?: string }).code,
    })
    ;({ data: staff, error: errStaff } = await supabase
      .from('utenti')
      .select('id, role, ruolo')
      .eq('id', authUid)
      .maybeSingle())
  }
  // L'errore va passato INTERO al logger, non il solo `.message`: un errore
  // PostgREST porta `code`/`details`/`hint`, ed è quella la terna che dice se è
  // una colonna mancante (42703) o un permesso negato. Il messaggio da solo no.
  if (errStaff)
    logEvento('auth', 'warn', { operazione: 'getProfiliForAuthUid', esito: 'utenti-non-letti' }, errStaff)
  /*
   * L'ARCHIVIAZIONE TOGLIE IL PROFILO STAFF, NON LA PERSONA.
   *
   * Si filtra qui, prima di comporre l'elenco, e non a valle: `decideAreaAccess`
   * ragiona sui profili, quindi un profilo `educator` lasciato in elenco
   * continuerebbe ad aprire l'area docente a chi non ci lavora più.
   *
   * Chi ha anche il ponte `parents` resta con UN profilo, `genitore`, e il
   * commutatore sparisce da sé (`CambiaProfiloMenuButton` non disegna niente
   * sotto i due profili). Chi non ce l'ha resta con ZERO profili: è il caso che
   * `GET /api/me` intercetta con un 403 esplicito, perché zero profili da soli
   * manderebbero al login in un giro senza uscita.
   */
  const archiviato = profiloStaffRevocato(
    (staff as { archiviato_il?: string | null } | null)?.archiviato_il,
  )
  const ruoloStaff = archiviato ? undefined : ((staff?.role || staff?.ruolo) as AppRole | undefined)
  if (ruoloStaff) profili.push({ ruolo: ruoloStaff, area: areaForRole(ruoloStaff) })

  const { data: parent, error: errParent } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authUid)
    .maybeSingle()
  if (errParent)
    logEvento('auth', 'warn', { operazione: 'getProfiliForAuthUid', esito: 'parents-non-letti' }, errParent)
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
