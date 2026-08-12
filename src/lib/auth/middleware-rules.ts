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
  // Modulo pubblico «Lavora con noi»: chi si candida come insegnante non ha (e
  // non deve avere) un account — l'account nasce solo se la Direzione approva.
  // La sua API sta sotto `/api/iscrizione` e da lì eredita già il passaggio
  // libero; questa voce serve alla PAGINA, che senza sarebbe reindirizzata al
  // login e il modulo non lo vedrebbe nessuno.
  //
  // ✅ LA PAGINA C'È — `src/app/lavora-con-noi/page.tsx`, dall'11/08/2026, e
  // `npm run build` la elenca come rotta (`ƒ /lavora-con-noi`). Fino a quel
  // giorno queste righe dicevano il contrario: la voce era stata aggiunta in
  // anticipo, insieme alla ROUTE, e il commento — «la pagina non esiste ancora,
  // questo percorso risponde 404» — è sopravvissuto alla cosa che descriveva.
  // Un documento che descrive un mondo che non c'è più è peggio di nessun
  // documento: la prossima persona lo legge come vero.
  //
  // Perché resta pubblica, che è l'unica cosa che questa voce deve garantire:
  // il modulo di candidatura è ANONIMO per costruzione — chi si propone come
  // insegnante non ha un account, e l'account nasce solo se la Direzione
  // approva. Senza questa riga la pagina verrebbe reindirizzata a `/auth/login`
  // e non la vedrebbe nessuno: un difetto che da server non si vede, perché lo
  // si scopre solo aprendo la pagina da disconnessi.
  // Il presidio è `__tests__/architecture/prefissi-pubblici.test.ts`, che da
  // oggi pretende (senza deroghe) che a questo prefisso corrisponda una pagina
  // vera: se `src/app/lavora-con-noi/` sparisce, il lock diventa rosso.
  '/lavora-con-noi',
  // Modulo pubblico «La tua anagrafica» (`/anagrafica-personale`): lo compila chi il
  // rapporto di lavoro ce l'ha GIÀ, e in quasi tutti i casi un account NON ce l'ha —
  // misurato l'11/08/2026: dieci insegnanti su tutta la cooperativa hanno un accesso,
  // otto delle quali a Giugliano. Il link lo manda la Segreteria; la pratica finisce
  // in `pratiche_personale`, e diventa anagrafica vera solo quando una persona
  // l'approva.
  //
  // ⚠️ NON è la stessa cosa di `/lavora-con-noi`, e la differenza va detta perché i
  // due percorsi si somigliano: là si RACCOGLIE una proposta da chi la Scuola non
  // conosce, qui si raccoglie l'anagrafica di chi ci lavora — codice fiscale,
  // documento d'identità e la sua scansione. La porta è aperta uguale (decisione del
  // titolare dell'11/08/2026, che ha valutato e scartato un OTP prima dei campi
  // sensibili): ciò che difende quei dati sta DIETRO la porta — tetto per indirizzo
  // IP, esca, bucket privato separato da quello dei minori, cancellazione a 90 giorni
  // delle pratiche non approvate. Vedi `src/lib/forms/personale-template.ts`.
  //
  // Senza questa riga la pagina finirebbe dietro il login: un difetto che da server
  // non si vede, perché si scopre solo aprendola da disconnessi — e a scoprirlo
  // sarebbe una maestra a cui è stato appena mandato il link.
  // `POST /api/iscrizione/personale` e la sua rotta di caricamento stanno sotto
  // `/api/iscrizione`, che passa già da qui sopra. Il presidio è
  // `__tests__/architecture/prefissi-pubblici.test.ts`: pretende che a questo
  // prefisso corrisponda una pagina VERA, senza deroghe.
  '/anagrafica-personale',
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
