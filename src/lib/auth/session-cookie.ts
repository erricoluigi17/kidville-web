// Presenza di una sessione Supabase, letta dai cookie SENZA validarla.
//
// Serve a UNA cosa sola: dire al gate biometrico, già nel root layout server,
// se c'è un utente collegato — così l'overlay di blocco non copre la schermata
// di login (il difetto che chiudeva l'utente fuori dall'app). Non è un
// controllo di autorizzazione e non deve diventarlo: chi decide se una rotta è
// accessibile resta il middleware, e chi decide se una API risponde resta il
// gate applicativo (`requireStaff`/`requireDocente`).
//
// `@supabase/ssr` scrive il token in un cookie `sb-<ref>-auth-token`, e lo
// SPEZZA in `...-auth-token.0`, `.1`, … quando supera la dimensione massima di
// un cookie. Vanno riconosciute entrambe le forme, altrimenti su un progetto
// con token lungo il flag risulterebbe sempre falso.

interface CookieLetto {
  name: string
}

interface CookieStore {
  getAll(): CookieLetto[]
}

const SESSIONE = /^sb-.+-auth-token(\.\d+)?$/

/** True se esiste un cookie di sessione Supabase (anche nella forma spezzata). */
export function haCookieSessione(cookieStore: CookieStore): boolean {
  try {
    return cookieStore.getAll().some((c) => SESSIONE.test(c.name))
  } catch {
    // Cookie non leggibili: si assume "non autenticato". È il default sicuro —
    // il gate resta spento e l'utente non rischia il lockout.
    return false
  }
}

/**
 * Come sopra, ma a partire dall'INTESTAZIONE `Cookie` grezza di una richiesta.
 *
 * Serve a `withRoute` (`src/lib/logging/with-route.ts`), che osserva l'esito di una route e
 * deve sapere se un 400 arriva da una sessione o da un anonimo — ma non può usare le API
 * solo-`NextRequest` (`request.cookies`): i ~90 test API del repo invocano gli handler con una
 * `Request` NUDA. Un header, invece, ce l'hanno tutte.
 *
 * Sta QUI e non lì per una ragione sola: il nome del cookie è già scritto in questo file, e
 * `sb-<ref>-auth-token` scritto due volte è `sb-<ref>-auth-token` che diverge la prima volta
 * che Supabase cambia forma — con l'effetto silenzioso di far tornare invisibile un'intera
 * classe di rifiuti.
 *
 * ⚠️ NON è un controllo di autorizzazione, come la funzione qui sopra: dice che una sessione
 * è STATA PRESENTATA, non che sia valida. Per decidere il LIVELLO DI UN LOG è esattamente
 * l'informazione giusta (un 400 con un cookie scaduto resta un 400 del nostro client); per
 * decidere un accesso non lo sarebbe mai.
 */
export function haCookieSessioneNellIntestazione(cookieHeader: string | null | undefined): boolean {
  try {
    if (typeof cookieHeader !== 'string' || cookieHeader === '') return false
    return cookieHeader
      .split(';')
      .some((pezzo) => SESSIONE.test(pezzo.split('=')[0].trim()))
  } catch {
    return false
  }
}
