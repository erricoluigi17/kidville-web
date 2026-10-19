/**
 * IL TETTO SULL'ATTESA FRA I TENTATIVI DI POSTGREST — la parte pura, che gira anche nel browser.
 * (Fase 11 della robustezza, S6 — 2026-10-19.)
 *
 * postgrest-js ritenta una GET (anche HEAD e OPTIONS) su 503 e 520, fino a tre volte, e fra un
 * tentativo e l'altro dorme quanto dice `Retry-After`, SENZA tetto (`Math.max(0, parseInt(h, 10)
 * || 0) * 1000`, in `executeWithRetry`). Un 503 con `Retry-After: 120` teneva appesa la query sei
 * minuti: sul server oltre il taglio della funzione, nel browser una schermata che carica per
 * sempre. Senza l'header l'attesa è già limitata (1 + 2 + 4 s).
 *
 * Qui si accorcia l'header a `ATTESA_RITENTATIVO_MAX_S`: l'attesa peggiore diventa tre volte quel
 * numero, e un database che si riprende in un paio di secondi viene ancora aspettato. Un valore che
 * non è un numero (una data HTTP) postgrest lo legge già come 0: si lascia com'è. Il corpo non si
 * tocca: la risposta nuova porta lo stesso flusso.
 *
 * Sul server lo applica `creaFetchStrumentato` (`src/lib/logging/supabase-fetch.ts`), solo sulle
 * risposte che postgrest ritenterà davvero; nel browser `fetchConAttesaLimitata`, sul client di
 * `getSupabase()`. Nessun import: questo file non deve tirare dentro il logger del server.
 */

export const ATTESA_RITENTATIVO_MAX_S = 2

/** Gli stati e i metodi che postgrest-js ritenta (letti dal suo sorgente, `RETRYABLE_*`). */
export const STATI_RITENTABILI: ReadonlySet<number> = new Set([503, 520])
export const METODI_RITENTABILI: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** La stessa risposta, con `Retry-After` accorciato se era più lungo del tetto. Non lancia. */
export function limitaRetryAfter(res: Response): Response {
  try {
    if (!STATI_RITENTABILI.has(res.status)) return res
    const grezzo = res.headers.get('retry-after')
    if (grezzo === null) return res
    const secondi = Number.parseInt(grezzo, 10)
    if (!Number.isFinite(secondi) || secondi <= ATTESA_RITENTATIVO_MAX_S) return res
    const headers = new Headers(res.headers)
    headers.set('retry-after', String(ATTESA_RITENTATIVO_MAX_S))
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  } catch {
    return res
  }
}

function metodoDi(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
  return String(m).toUpperCase()
}

function indirizzoDi(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Il `fetch` del client di browser: tutto passa intatto, tranne il `Retry-After` delle risposte
 * del database (`/rest/v1/`) che postgrest ritenterà. Il `fetch` globale si risolve a ogni
 * chiamata, come fa il fetch strumentato del server, così il patch di `window.fetch` del logger
 * del client (`src/lib/logging/client.ts`) continua a vedere ogni richiesta.
 */
export function fetchConAttesaLimitata(base?: typeof fetch): typeof fetch {
  const chiama: typeof fetch = base ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    const res = await chiama(input, init)
    try {
      if (!METODI_RITENTABILI.has(metodoDi(input, init))) return res
      if (!indirizzoDi(input).includes('/rest/v1/')) return res
    } catch {
      return res
    }
    return limitaRetryAfter(res)
  }
}
