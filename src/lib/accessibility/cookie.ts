// Cookie di persistenza per l'alto contrasto (Legge Stanca / AgID).
// Letto server-side nel root layout per impostare `<html data-contrast>` già al
// primo paint (no FOUC) e client-side dal provider per sincronizzare lo stato.

export const CONTRAST_COOKIE = 'kv_contrast'
export const CONTRAST_MAX_AGE = 60 * 60 * 24 * 365 // 1 anno

interface CookieStore {
  get(name: string): { value: string } | undefined
}

/** True se il cookie alto-contrasto è impostato su "high". */
export function readContrastCookie(cookieStore: CookieStore): boolean {
  return cookieStore.get(CONTRAST_COOKIE)?.value === 'high'
}
