import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
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
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
 * Client con privilegi di amministrazione (Service Role)
 * Da usare SOLO lato server e per operazioni critiche che devono bypassare RLS
 */
export async function createAdminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() { },
      },
    }
  )
}

