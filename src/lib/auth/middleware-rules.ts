/**
 * Regole pure di routing per `src/middleware.ts`, isolate qui per essere
 * unit-testabili senza costruire un `NextRequest` reale.
 *
 * Principi P0:
 *  - Le rotte PUBBLICHE (auth, iscrizione pubblica, link form, panic, onboarding)
 *    non richiedono sessione e non vengono mai reindirizzate.
 *  - La radice `/` NON è più una landing pubblica: è un instradatore che richiede
 *    l'accesso (come la dashboard). Da anonimo va al login; da autenticato la
 *    server component `app/page.tsx` smista sulla home del ruolo.
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
  '/m', // link pubblico dei modelli pubblicati (DL-030)
  '/api/public', // API token-scoped per i form pubblicati (DL-030)
  '/onboarding',
  '/privacy', // informativa GDPR pubblica (Privacy Policy URL per lo store)
  '/termini', // termini di servizio pubblici
  '/assistenza', // pagina di supporto pubblica (Support URL per lo store)
  // Cancellazione account via risorsa web pubblica (Google Play Data safety): DEVE essere
  // raggiungibile senza login — l'utente potrebbe aver già disinstallato l'app. Il prefisso
  // copre anche /cancellazione-account/conferma (magic-link). La pagina NON cancella: registra
  // una richiesta pending che la Direzione evade, come il percorso in-app.
  '/cancellazione-account',
  // Ripiego offline pre-cachato dal Service Worker. DEVE essere pubblica: senza,
  // il pre-cache in `install` scaricherebbe il 307 verso /auth/login invece
  // della pagina, e offline l'app mostrerebbe un redirect al posto del ripiego.
  '/offline',
  // Prova di titolarità del dominio per Google Search Console, prerequisito della
  // conversione dell'account Play Console da personale a organizzazione
  // (`Account sviluppatore → Dettagli account → Cambia tipo di account` resta
  // disattivato finché un sito web non è verificato).
  //
  // Perché serve una riga qui e non basta metterlo in `public/`: il matcher di
  // `src/middleware.ts` esclude dagli intercetti le estensioni statiche
  // (svg|png|…|txt|webmanifest|woff2) ma **non `.html`**. Senza questa voce il
  // crawler di verifica riceverebbe il 307 verso /auth/login e la verifica
  // fallirebbe — con un file che a occhio è lì e si scarica benissimo da browser
  // autenticato. È lo stesso inciampo già pagato con `/manifest.webmanifest`.
  //
  // Il token NON è un segreto: è nato per essere letto da chiunque, ed è la sua
  // pubblicità a fare da prova. Non va rimosso dopo la verifica — Google lo
  // ricontrolla e revoca la proprietà se sparisce.
  '/google8a174b25967018e2.html',
];

export function isPublicPath(pathname: string): boolean {
  // La radice `/` è intenzionalmente ASSENTE: richiede l'accesso e va al login
  // da anonimo (poi `app/page.tsx` smista per ruolo da autenticato).
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
