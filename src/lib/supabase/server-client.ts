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
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUESTO FILE È L'UNICO POSTO IN CUI SI COSTRUISCE UN CLIENT SUPABASE LATO SERVER (2026-08-03).
 *
 * Fino a oggi non lo era, e la differenza non si vedeva da nessuna parte. Sei route
 * (`admin/regenerate-credentials`, `admin/credentials-pdf`, `admin/students/[id]`,
 * `admin/backfill-auth`, `admin/test-relations`, `admin/wipe`) importavano `createClient` da
 * `@supabase/supabase-js` e si costruivano il proprio client con la service-role key. Un client
 * così è **muto e senza tetto**: nessuna riga quando PostgREST risponde 4xx a una scrittura che
 * il codice non guarda (regola 7 di AGENTS.md: PostgREST non lancia, ritorna `{ error }`), e
 * nessuna scadenza quando il bersaglio accetta la connessione e tace — misurato: 150 secondi
 * appesi, senza eccezione. Fra quelle sei c'erano le DUE che gestiscono le credenziali dei
 * genitori, cioè il percorso da cui nasce l'intera regola 3.
 *
 * La regola, adesso: **un client server-side si prende da qui, sempre.** Non è una preferenza di
 * stile — è la sola cosa che rende vera l'invariante di `supabase-fetch.ts`, che vale per le
 * chiamate che passano dal suo `fetch` e per nessun'altra. Il lock che lo tiene è
 * `__tests__/architecture/supabase-client-strumentato.test.ts`, e dichiara per iscritto anche
 * ciò che NON copre.
 * ─────────────────────────────────────────────────────────────────────────────────
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
 * Client di sola VERIFICA delle credenziali (chiave ANON, **senza cookie**).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A COSA SERVE, ed è un caso solo: `POST /api/account/password` deve accertare che
 * chi chiede il cambio conosca la password ATTUALE. GoTrue non lo fa da sé —
 * `secure_password_change = false` (`supabase/config.toml:223`) — quindi l'unico modo
 * di verificarla è tentare un accesso vero con essa (`signInWithPassword`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ NON `createSessionClient()`, che pure ha la chiave anon.
 *
 * Perché quello propaga i cookie E LI RISCRIVE (`setAll`). Un `signInWithPassword`
 * fatto con quel client APRE UNA SESSIONE NUOVA e ne deposita i cookie **a metà
 * richiesta**, sostituendo quella del chiamante: un controllo di sicurezza che, nel
 * verificare, cambia l'identità di chi sta chiedendo. Con la password GIUSTA sarebbe
 * la stessa persona e non si vedrebbe niente; con quella SBAGLIATA il tentativo
 * fallisce e i cookie non si toccano. Il guasto vivrebbe quindi solo nei casi in
 * mezzo, ed è esattamente la forma di difetto che non si scopre provando.
 *
 * I due `cookies` no-op non sono un dettaglio di stile: sono il presidio. Il client
 * legge zero cookie (nessuna sessione da propagare: qui l'identità non c'entra, si
 * sta provando una password) e ne scrive zero (la sessione che GoTrue apre resta
 * nella memoria di questa funzione e muore con la richiesta).
 *
 * ⚠️ EFFETTO COLLATERALE DICHIARATO: una verifica RIUSCITA crea comunque una riga in
 * `auth.sessions`, perché `POST /token?grant_type=password` è l'unico modo che GoTrue
 * dà di provare una password e una sessione la apre sempre. Nessuno ne possiede i
 * token — non escono da qui — e sul percorso felice la riga sparisce subito dopo:
 * l'admin API, cambiando la password, cancella TUTTE le sessioni di quell'utente
 * (misurato sul sorgente di GoTrue, vedi la route). Resta solo se il cambio fallisce
 * dopo la verifica, e scade da sé.
 *
 * Il `fetch` strumentato c'è come su tutti gli altri: una verifica di credenziali che
 * resta appesa perché GoTrue accetta e tace è un login che non finisce mai, e senza
 * la riga non si distinguerebbe da una password sbagliata.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function createVerificaClient() {
  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
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

