/**
 * Regole pure di routing per `src/middleware.ts`, isolate qui per essere
 * unit-testabili senza costruire un `NextRequest` reale.
 *
 * Principi P0:
 *  - Le rotte PUBBLICHE (landing, auth, iscrizione pubblica, link form, panic) non
 *    richiedono sessione e non vengono mai reindirizzate.
 *  - Le API protette NON vengono reindirizzate: l'eventuale 401 è compito del gate
 *    (`requireStaff`/`requireDocente`/...), non del middleware.
 *  - Le navigazioni di PAGINA verso aree protette, da anonimo, vanno a `/auth/login`.
 */

/** Prefissi pubblici: match esatto sul prefisso o sul prefisso seguito da `/`. */
const PUBLIC_PREFIXES = [
  '/auth',
  '/iscrizione',
  '/api/iscrizione',
  '/api/forms',
  '/api/panic-alert',
  '/forms',
  '/onboarding',
];

export function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** True se una navigazione anonima va reindirizzata al login. */
export function shouldRedirect(pathname: string, hasSession: boolean): boolean {
  if (hasSession) return false;
  if (isPublicPath(pathname)) return false;
  if (isApiPath(pathname)) return false; // gestita dal gate (401 JSON)
  return true;
}
