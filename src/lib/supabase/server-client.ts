import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './public-config'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

/**
 * Client di SESSIONE reale (chiave ANON + cookie).
 *
 * A differenza di `createClient()` — che usa la SERVICE_ROLE_KEY e quindi
 * bypassa la RLS — questo client usa la chiave anon e propaga la sessione
 * dell'utente tramite i cookie, per cui le policy RLS vengono applicate
 * davvero in base a `auth.uid()`.
 *
 * Da usare nelle route che devono rispettare la RLS (es. dati economici lato
 * genitore: il genitore deve vedere solo i pagamenti dei propri figli).
 */
export async function createSessionClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Chiamato da un Server Component: ignorabile se il refresh della
            // sessione è gestito dal middleware.
          }
        },
      },
    }
  )
}

/**
 * Client per le LETTURE lato genitore (P0/S8).
 *
 * Quando il rollout RLS è attivo (`PARENT_READS_USE_SESSION === 'true'`) usa il
 * session-client (RLS applicata via `auth.uid()`, isolamento per figlio);
 * altrimenti ricade sul service-role (comportamento attuale). **Default OFF**: il
 * flip è uno step di ROLLOUT, da fare dopo (a) l'onboarding dei genitori (login
 * reale → sessione) e (b) la migrazione delle letture anon dirette del frontend
 * (`alunni`/`legame_genitori_alunni`/`utenti`/`form_*`) verso API/policy
 * `authenticated`, prima di rimuovere le policy permissive (S9) e sigillare (S13).
 */
export async function createParentReadClient() {
  if (process.env.PARENT_READS_USE_SESSION === 'true') {
    return createSessionClient()
  }
  return createAdminClient()
}

/**
 * Client con privilegi di amministrazione (Service Role)
 * Da usare SOLO lato server e per operazioni critiche che devono bypassare RLS
 */
export async function createAdminClient() {
  return createServerClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() { },
      },
    }
  )
}

