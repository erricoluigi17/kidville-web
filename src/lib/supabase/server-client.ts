import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './public-config'
import { creaFetchStrumentato } from '../logging/supabase-fetch'

/**
 * Un solo punto di intercettazione per TUTTO ciò che parte verso Supabase: REST, RPC, Storage,
 * Auth. Vede il 4xx HTTP anche quando il codice applicativo ignora l'`{ error }` che PostgREST
 * gli restituisce — che nel repo succede in 73 scritture fire-and-forget. Vedi
 * `src/lib/logging/supabase-fetch.ts` per l'invariante e la politica dei livelli.
 *
 * Istanziato UNA VOLTA a livello di modulo: non tiene stato per richiesta (il contesto viaggia
 * su AsyncLocalStorage), e il `fetch` globale lo risolve a ogni chiamata, non qui.
 *
 * Va su TUTTI i factory, non solo sull'admin: `createClient()` è quello che usa
 * `resolveIdentity()` in `src/lib/auth/require-staff.ts`, cioè il GATE DI AUTENTICAZIONE.
 * Strumentare solo l'admin significherebbe non vedere mai le query che rompono i login.
 * L'unica eccezione è `createLogClient` — vedi in fondo.
 */
const fetchStrumentato = creaFetchStrumentato()

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: { fetch: fetchStrumentato },
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
      global: { fetch: fetchStrumentato },
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
      global: { fetch: fetchStrumentato },
      cookies: {
        getAll() { return [] },
        setAll() { },
      },
    }
  )
}

/**
 * Client dedicato alla scrittura dei LOG. È l'unico SENZA fetch strumentato: se lo avesse, un
 * errore di scrittura su `app_log` genererebbe un log di errore che tenta di scrivere su
 * `app_log` → ricorsione infinita.
 *
 * È la PRIMA difesa, e quella strutturale: il fetch non passa proprio da qui. La seconda è la
 * guardia `inLogger()` dentro il fetch strumentato, che copre il caso in cui qualcuno usasse un
 * client normale dentro il logger. Due difese perché una sola, qui, vuol dire OOM in produzione.
 *
 * Nessun cookie: la scrittura dei log avviene anche fuori da una richiesta (cron, boot,
 * `waitUntil`), dove `cookies()` non esiste e lancerebbe.
 */
export async function createLogClient() {
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

