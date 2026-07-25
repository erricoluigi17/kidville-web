// Service Worker — Web Push notifiche Kidville (modulo Pagamenti)
// + cache offline del guscio app (statici + navigazioni) per web e nativo.
//
// ─── PERCHÉ QUESTO FILE È STATO RISCRITTO (v1 → v2) ─────────────────────────
// Nella v1 l'app offline non si apriva su NESSUNA delle due piattaforme, e la
// causa era una sola riga: `networkFirst` metteva in cache solo se `res.ok`.
// La WebView apre sempre la root `https://app.kidville.it/`, che risponde 307
// verso `/auth/login`; e una NAVIGAZIONE ha per specifica `redirect: 'manual'`,
// quindi `fetch(request)` non segue il redirect e restituisce una
// **opaqueredirect** (`status: 0`, `ok: false`). Nessun documento entrava mai in
// cache sotto la chiave `/`. Online funzionava lo stesso perché il redirect lo
// segue il browser; offline restava `net::ERR_FAILED` (Android) o una schermata
// bianca (iOS). E `install` non pre-cacheva nulla, quindi non c'era neanche una
// pagina di ripiego.
//
// Su iOS c'era in più un secondo guasto, fuori da questo file: senza
// `WKAppBoundDomains` in Info.plist, WKWebView non registra affatto i service
// worker (prova forense: la CacheStorage del container conteneva solo `salt`).
//
// ─── INVARIANTE DA NON ROMPERE: le richieste RSC NON si intercettano ─────────
// Quando la fetch RSC di Next fallisce, il router ricade su una navigazione MPA
// completa (`fetch-server-response.js`: «If fetch fails handle it like a mpa
// navigation»), che passa di qui come `navigate` e trova il documento in cache.
// È così che funziona la navigazione interna offline. Se un domani si "ottimizza"
// cacheando anche l'RSC, quella fetch SMETTE di fallire, il fallback MPA non
// scatta più e il router prova a idratare un payload vecchio: la navigazione
// offline si rompe in un modo che nessuno collega a questa riga. Il test
// `__tests__/offline/sw.test.ts` la difende.

const VERSIONE = 'v2';
const CACHE_SHELL = 'kidville-shell-' + VERSIONE;

/** Pagina di ripiego, pre-cachata in `install`. Pubblica: vedi PUBLIC_PREFIXES. */
const ROTTA_OFFLINE = '/offline';

/**
 * Prefissi che NON entrano mai in cache.
 *  · `/api/`  → i dati dinamici li gestisce Dexie (read-cache) a livello app,
 *               così non si serve mai una risposta API stantia;
 *  · `/m/`    → il path CONTIENE il token del modulo pubblico: è una credenziale,
 *               e non deve finire scritto su disco nemmeno come chiave di cache;
 *  · `/auth/callback` → scambio di sessione, non un documento.
 */
const MAI_IN_CACHE = ['/api/', '/m/', '/auth/callback'];

/**
 * Ultimissimo ripiego, in linea: si usa solo se anche il pre-cache di /offline è
 * fallito. Non ha dipendenze (né CSS, né JS, né font) proprio perché è la rete
 * che deve reggere quando non regge nient'altro. Bilingue statico: il SW non ha
 * accesso ai cataloghi i18n.
 */
const SHELL_MINIMA =
  '<!doctype html><html lang="it"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<title>Kidville</title><style>' +
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;' +
  'justify-content:center;gap:12px;background:#006A5F;color:#fff;text-align:center;padding:32px;' +
  'font-family:system-ui,-apple-system,sans-serif}h1{font-size:22px;margin:0}' +
  'p{margin:0;opacity:.85;font-size:15px;max-width:22em}' +
  'a{margin-top:12px;background:#FDC400;color:#006A5F;text-decoration:none;font-weight:700;' +
  'padding:12px 24px;border-radius:999px}</style></head><body data-kv-shell-minima>' +
  '<h1>Kidville non è raggiungibile</h1>' +
  '<p>Controlla la connessione e riprova. / Check your connection and try again.</p>' +
  '<a href="/">Riprova / Retry</a></body></html>';

/* ───────────────────────────── helper ────────────────────────────────────── */

/**
 * Chiave di cache di un documento: SENZA query.
 *
 * Perché si normalizza: `/auth/login?next=%2F` e `/auth/login` sono lo stesso
 * guscio, e nella v1 finivano in due voci diverse — motivo per cui una
 * navigazione offline mancava sistematicamente il bersaglio. In più la query è
 * il posto dove vivono `?userId=`, `?next=` e le date: toglierla significa non
 * scriverli su disco come chiave, e tenere la cardinalità della cache legata al
 * numero di rotte (~60) invece che alle combinazioni di parametri.
 *
 * Il contro, da conoscere: due pagine che differiscono SOLO per query
 * condividono un documento. Oggi è innocuo perché i documenti sono gusci e i
 * dati arrivano da `/api/*` (mai cachate) e da Dexie. Smetterebbe di esserlo il
 * giorno in cui una rotta rendesse contenuto SERVER-SIDE dipendente dalla query:
 * in quel caso serve un'eccezione esplicita qui dentro.
 */
function chiaveDocumento(url) {
  return new Request(url.origin + url.pathname);
}

function documentoCacheabile(url) {
  for (const p of MAI_IN_CACHE) {
    if (url.pathname === p || url.pathname.startsWith(p)) return false;
  }
  return true;
}

/**
 * Ricostruisce una Response perché possa essere servita a una NAVIGAZIONE.
 *
 * Una risposta ottenuta seguendo un redirect porta `redirected = true`, e il
 * browser RIFIUTA di consegnarla a una richiesta di navigazione (che ha redirect
 * mode 'manual'): diventa un errore di rete, cioè esattamente la schermata
 * bianca che stiamo eliminando. Ricostruirla azzera la sua lista di URL.
 *
 * Effetto collaterale voluto: `res.headers` è la vista JS della risposta, che
 * non espone `Set-Cookie` → il documento salvato su disco non porta con sé
 * cookie di sessione.
 */
async function ricostruisci(res) {
  const corpo = await res.blob();
  return new Response(corpo, { status: 200, statusText: 'OK', headers: res.headers });
}

/** Riduce un path al suo gruppo, per il log: mai id, mai token, mai query. */
function bucketRotta(pathname) {
  if (pathname === '/' || pathname === '') return '/';
  for (const p of ['/auth', '/parent', '/teacher', '/admin', '/offline']) {
    if (pathname === p || pathname.startsWith(p + '/')) return p;
  }
  return 'altro';
}

/**
 * Il Service Worker NON logga: RIFERISCE.
 *
 * `AGENTS.md` vieta `console.*` in `src/` e impone il logger applicativo, che da
 * qui non è importabile (tira dentro `node:crypto`). La scappatoia formale —
 * «questo file non sta sotto src/, quindi la regola non lo copre» — non si
 * prende: la regola esiste perché un log fuori dalla pipeline salta la redazione
 * e non arriva mai in `app_log`. Quindi si manda un messaggio ai client, e
 * `ServiceWorkerRegister` (che È in src/) lo traduce in `logClient`.
 *
 * Non viaggia MAI un URL: solo uno slug fisso e il bucket della rotta.
 */
function avvisa(evento, livello, bucket) {
  try {
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (lista) {
        for (const client of lista) {
          client.postMessage({ tipo: 'kv-sw-log', evento: evento, livello: livello, bucket: bucket });
        }
      })
      .catch(function () {
        /* nessun client in ascolto: non è un guasto */
      });
  } catch {
    // Fail-open (AGENTS.md, regola 9): un bug dell'osservabilità non può
    // diventare un bug del prodotto. È l'unico catch muto ammesso qui.
  }
}

/* ───────────────────────────── ciclo di vita ─────────────────────────────── */

/** URL ASSOLUTA di /offline: le chiavi di cache sono sempre assolute. */
function urlOffline() {
  return self.location.origin + ROTTA_OFFLINE;
}

async function precarica() {
  try {
    const req = new Request(urlOffline(), {
      credentials: 'same-origin',
      // 'follow': qui NON siamo in una navigazione, quindi il redirect si può
      // seguire. `cache: 'reload'` evita di pre-cachare una copia già vecchia.
      redirect: 'follow',
      cache: 'reload',
    });
    const res = await fetch(req);
    if (!res || !res.ok) throw new Error('offline non disponibile');
    const cache = await caches.open(CACHE_SHELL);
    await cache.put(new Request(urlOffline()), await ricostruisci(res));
  } catch {
    // Il pre-cache fallito NON deve impedire l'installazione: senza /offline
    // resta comunque SHELL_MINIMA. Ma si dice, perché il prossimo avvio senza
    // rete sarà degradato.
    avvisa('sw-precache-offline-fallita', 'warn', ROTTA_OFFLINE);
  }
}

// install: pre-cacha la pagina di ripiego e attiva subito il nuovo SW.
self.addEventListener('install', function (event) {
  event.waitUntil(precarica());
  self.skipWaiting();
});

// activate: prende il controllo dei client aperti, elimina le cache di versioni
// precedenti (nome diverso da CACHE_SHELL) e ri-precarica /offline — è il punto
// in cui si recupera un cambio di lingua avvenuto dopo l'installazione.
// Tutto in try/catch: un errore qui non deve impedire l'attivazione.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      try {
        const nomi = await caches.keys();
        await Promise.all(
          nomi.map(function (n) {
            return n === CACHE_SHELL ? undefined : caches.delete(n);
          })
        );
      } catch {
        // Pulizia cache fallita: non pregiudica il funzionamento, si ignora.
      }
      try {
        await self.clients.claim();
      } catch {
        // clients.claim non supportato/fallito: ininfluente.
      }
      await precarica();
    })()
  );
});

/* ───────────────────────────── strategie ─────────────────────────────────── */

// Serve una richiesta cache-first: se in cache la restituisce, altrimenti va in
// rete e memorizza la risposta ok. Mai lancia: in caso di guasto totale rilancia
// alla rete grezza (che gestirà l'eventuale errore di navigazione).
async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
    const res = await fetch(request);
    if (res && res.ok) {
      try {
        const cache = await caches.open(CACHE_SHELL);
        await cache.put(request, res.clone());
      } catch {
        // put fallita (quota/opaque): si ignora, la risposta è già pronta.
      }
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return fetch(request);
  }
}

async function salvaDocumento(url, res) {
  try {
    const cache = await caches.open(CACHE_SHELL);
    // `ricostruisci` anche quando non c'è stato redirect: costa un blob e rende
    // la voce salvata sempre servibile a una navigazione, qualunque sia la sua
    // provenienza.
    await cache.put(chiaveDocumento(url), await ricostruisci(res));
  } catch {
    // put fallita (quota, storage disabilitato): è un'ottimizzazione mancata,
    // non un errore del prodotto. La risposta all'utente è già partita.
  }
}

/**
 * Catena di ripiego offline. NON rigetta MAI: se arriva qui, l'alternativa è la
 * schermata di errore del browser, ed è ciò che stiamo eliminando.
 *
 * Nota deliberata: NON si serve «l'ultima pagina visitata» al posto di un'altra
 * rotta. Consegnare l'HTML di `/parent/diary` all'URL `/parent/avvisi` farebbe
 * idratare React con il `canonicalUrl` sbagliato. L'ultima pagina si raggiunge
 * con un tap dal link della pagina /offline, che porta all'URL giusto e quindi
 * al documento giusto.
 */
async function documentoDiRipiego(url) {
  try {
    const esatto = await caches.match(chiaveDocumento(url));
    if (esatto) {
      avvisa('sw-documento-da-cache', 'warn', bucketRotta(url.pathname));
      return esatto;
    }
  } catch {
    // lettura cache non disponibile: si prosegue con i ripieghi successivi
  }
  try {
    const offline = await caches.match(new Request(urlOffline()));
    if (offline) {
      avvisa('sw-pagina-offline-servita', 'warn', bucketRotta(url.pathname));
      return offline;
    }
  } catch {
    // idem
  }
  // Se si arriva qui è rotto tutto il meccanismo: il pre-cache è fallito E non
  // c'è alcun documento salvato. Va detto forte.
  avvisa('sw-shell-minima-servita', 'warn', bucketRotta(url.pathname));
  return new Response(SHELL_MINIMA, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function navigazione(event) {
  const url = new URL(event.request.url);
  try {
    const res = await fetch(event.request);
    // Il 307 della root visto da una navigazione: `redirect: 'manual'` produce
    // una opaqueredirect, che NON è un documento. Si restituisce così com'è e il
    // browser segue il redirect da sé, riemettendo una seconda navigazione —
    // quella sì cacheabile, e infatti è come finisce in cache /auth/login.
    if (!res || res.type === 'opaqueredirect' || res.status === 0) return res;
    if (res.ok && documentoCacheabile(url)) {
      // `waitUntil` e non `await`: la scrittura non deve ritardare il paint.
      event.waitUntil(salvaDocumento(url, res.clone()));
    }
    return res;
  } catch {
    return documentoDiRipiego(url);
  }
}

function isStaticAsset(url) {
  if (url.pathname.startsWith('/_next/static/')) return true;
  return /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(url.pathname);
}

/** Richiesta RSC di Next: `?_rsc=<hash>` oppure header `RSC: 1`. */
function isRichiestaRSC(url, request) {
  if (url.searchParams.has('_rsc')) return true;
  try {
    return !!request.headers.get('RSC');
  } catch {
    return false;
  }
}

// fetch: intercetta solo GET same-origin. Le API (/api/) passano SEMPRE alla rete
// (i loro dati li cachea Dexie a livello app, non il SW → mai API stantie).
self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // URL malformato: lascia gestire al browser.
  }

  if (url.origin !== self.location.origin) return; // solo same-origin
  if (url.pathname.startsWith('/api/')) return; // dati dinamici: sempre rete

  // INVARIANTE: l'RSC deve poter FALLIRE. Vedi il commento in testa al file.
  if (isRichiestaRSC(url, request)) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigazione(event));
    return;
  }
  // Tutto il resto: nessun intervento, comportamento di rete di default.
});

self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Kidville', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Kidville';
  const options = {
    body: data.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientsArr) {
      for (const client of clientsArr) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
