import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'

export type StaffRole = 'admin' | 'coordinator'
export type AppRole = 'admin' | 'coordinator' | 'educator' | 'genitore'

export interface AppUser {
  id: string
  role: AppRole
  nome?: string | null
  cognome?: string | null
  scuola_id?: string | null
}

/**
 * Risultato dei controlli auth: o `{ user }`, o `{ response }` (401/403 pronta).
 */
export type AuthResult =
  | { user: AppUser; response?: undefined }
  | { user?: undefined; response: NextResponse }

/**
 * Estrae l'id utente dalla richiesta secondo il modello di auth REALE del
 * progetto (app-level, NON Supabase Auth): l'identità arriva come header
 * `x-user-id` oppure query `?userId=`. Vedi nota di sicurezza sotto.
 */
export function getRequestUserId(request: Request): string | null {
  const header = request.headers.get('x-user-id')
  if (header) return header
  try {
    const url = new URL(request.url)
    return url.searchParams.get('userId')
  } catch {
    return null
  }
}

/**
 * Carica l'utente applicativo da `utenti` (tabella reale: il DB non usa
 * Supabase Auth, `utenti.id ≠ auth.uid()`). Usa il client service-role perché
 * è il pattern di tutta la codebase; l'enforcement è applicativo.
 */
export async function loadAppUser(userId: string): Promise<AppUser | null> {
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('utenti')
    .select('id, nome, cognome, ruolo, role, scuola_id')
    .eq('id', userId)
    .single()
  if (error || !data) return null
  return {
    id: data.id,
    role: (data.role || data.ruolo) as AppRole,
    nome: data.nome,
    cognome: data.cognome,
    scuola_id: data.scuola_id,
  }
}

/**
 * Garantisce che la richiesta provenga da un membro dello staff
 * (`admin`/`coordinator`). Enforcement APPLICATIVO: legge l'id dalla richiesta
 * (`x-user-id`/`?userId=`) e ne verifica il ruolo su `utenti`.
 *
 * ⚠️ NOTA DI SICUREZZA (da irrigidire in produzione): il client fornisce il
 * proprio `userId`, esattamente come nel resto della codebase. La protezione
 * forte (RLS via `auth.uid()`) richiede la migrazione a Supabase Auth; le
 * policy RLS sono già scritte e si attiveranno allora. Vedi memoria
 * `kidville-auth-model`.
 *
 * Uso:
 * ```ts
 * const auth = await requireStaff(request)
 * if (auth.response) return auth.response
 * const staffId = auth.user.id
 * ```
 */
export async function requireStaff(
  request: Request,
  allowed: StaffRole[] = ['admin', 'coordinator']
): Promise<AuthResult> {
  const userId = getRequestUserId(request)
  if (!userId) {
    return {
      response: NextResponse.json(
        { error: 'Non autenticato: userId mancante' },
        { status: 401 }
      ),
    }
  }

  const user = await loadAppUser(userId)
  if (!user || !allowed.includes(user.role as StaffRole)) {
    return {
      response: NextResponse.json(
        { error: 'Accesso negato: operazione riservata allo staff' },
        { status: 403 }
      ),
    }
  }

  return { user }
}

/**
 * Garantisce che la richiesta provenga da un utente autenticato qualsiasi
 * (qualsiasi ruolo). Per route lette dal genitore: lo scoping ai propri figli
 * va poi fatto in query via `legame_genitori_alunni`.
 */
export async function requireUser(request: Request): Promise<AuthResult> {
  const userId = getRequestUserId(request)
  if (!userId) {
    return {
      response: NextResponse.json(
        { error: 'Non autenticato: userId mancante' },
        { status: 401 }
      ),
    }
  }
  const user = await loadAppUser(userId)
  if (!user) {
    return {
      response: NextResponse.json({ error: 'Utente non trovato' }, { status: 401 }),
    }
  }
  return { user }
}
