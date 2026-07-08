import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser, type AuthResult } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'

/**
 * Gate per le route lette/scritte dal GENITORE su uno specifico alunno.
 *
 * Chiude in un colpo solo i due buchi trovati dal test 360°:
 *  1. Auth-bypass (`?userId=` arbitrario): usa `requireUser` → `resolveIdentity`,
 *     che lega l'identità alla SESSIONE reale (con `ALLOW_HEADER_IDENTITY=false`
 *     l'header/query non è più accettato). 401 se non autenticato.
 *  2. IDOR sulla famiglia: se il ruolo è `genitore`, verifica il legame
 *     genitore↔alunno con `genitoreHasFiglio` (unione robusta
 *     `legame_genitori_alunni` + `student_parents` via ponte `parents.auth_user_id`).
 *     403 se l'alunno NON è suo figlio.
 *
 * Staff/educator passano: il loro scope (plesso/sezione) è applicato altrove
 * nelle rispettive query. È il pattern già provato in prod da
 * `src/app/api/parent/primaria/route.ts` (qui centralizzato e riusabile).
 *
 * Uso (dopo aver risolto `studentId`, es. da `parseQuery`):
 * ```ts
 * const auth = await requireParentOfStudent(request, studentId)
 * if (auth.response) return auth.response
 * const userId = auth.user.id
 * ```
 */
export async function requireParentOfStudent(
  request: Request,
  studentId: string
): Promise<AuthResult> {
  const auth = await requireUser(request)
  if (auth.response) return auth
  if (auth.user.role === 'genitore') {
    const supabase = await createAdminClient()
    const ok = await genitoreHasFiglio(supabase, auth.user.id, studentId)
    if (!ok) {
      return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    }
  }
  return { user: auth.user }
}
