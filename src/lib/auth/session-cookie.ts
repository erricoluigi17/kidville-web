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
