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

// ─── INVARIANTE: SI SERVE DA CACHE SOLO CIÒ CHE NON PUÒ ESSERE CAMBIATO ────
// Il 31/07 due esecutori, uno dopo l'altro, hanno misurato «un'app rotta» che
// rotta non era. Il SW teneva in cache `/_next/static/chunks/src_00w6rj3._.js`
// da 246.051 byte mentre il dev server ne serviva una da 256.678: la pagina
// alzava `ReferenceError: setErroreElenco is not defined`, un errore di
// hydration, e mostrava «NESSUN ALUNNO TROVATO» con 25 alunni a database. La
// ricarica non lo sanava. Due collaudi bruciati a rincorrere un fantasma.
//
// La causa non è «lo sviluppo», è la MUTABILITÀ dell'URL. Misure con `curl -I`
// del 2026-08-01:
//   next dev      /_next/static/chunks/*.js  → `no-cache, must-revalidate`
//   produzione    /_next/static/chunks/*.js  → `public,max-age=31536000,immutable`
//   produzione    /favicon.ico, /mascot.png  → `public, max-age=0, must-revalidate`
// In produzione il nome del chunk CONTIENE l'hash del contenuto: quell'URL non
// cambierà mai significato, e cache-first è corretto. Con Turbopack in sviluppo
// il nome è stabile e il contenuto cambia a ogni ricompilazione: lo stesso URL è
// un file diverso, e cache-first congela il primo che passa, per sempre.
//
// E non è una nostra deduzione dall'hostname: è NEXT a dirlo, esplicitamente, in
// `next/dist/server/lib/router-server.js` — «se la risorsa è in `_next/static`:
// in dev `no-cache, must-revalidate`, altrimenti `public, max-age=31536000,
// immutable`». Leggere quell'header invece di indovinare l'ambiente ha una
// conseguenza pratica che conta: con `next start` in locale — il modo in cui si
// collauda l'app nativa — gli asset tornano immutabili, quindi la cache offline
// continua a funzionare esattamente come in produzione.
//
// Da qui la regola, che vale in ogni ambiente e non chiede a nessuno di
// ricordarsi niente:
//   · si SERVE dalla cache senza passare dalla rete solo ciò che la risposta
//     dichiara immutabile (`immutable`, o un `max-age` di almeno un giorno);
//   · tutto il resto è rete-prima-e-cache-di-riserva: online si vede sempre la
//     copia fresca, offline si vede l'ultima buona;
//   · sotto `/_next/static/` ciò che non è immutabile non si scrive nemmeno:
//     in sviluppo la cache resta vuota, com'è giusto.
// Il difetto non è più «noto»: è impossibile. `__tests__/offline/sw.test.ts`
// lo riproduce (246 KB → 256 KB) e tiene ferma anche la metà opposta, cioè che
// in produzione gli asset con hash restino cache-first.
//
// E se un domani un collaudo sembrasse vedere codice che non esiste più, la
// prova che scagiona (o incolpa) il Service Worker in cinque secondi, dalla
// console del browser:
//   await Promise.all((await navigator.serviceWorker.getRegistrations())
//     .map(function (r) { return r.unregister(); }));
//   await Promise.all((await caches.keys()).map(function (k) { return caches.delete(k); }));
// poi si ricarica. Se il sintomo resta, la cache non c'entrava: è il codice.

// ─── PERCHÉ `VERSIONE` È PASSATA A v4 (e perché sotto c'è un hash) ──────────
// La PR #46 ha riscritto la pagina /offline senza toccare questo file. Il
// browser reinstalla un Service Worker solo se ne cambiano i BYTE: nessuna
// reinstallazione, nessun `activate`, `precarica()` mai rieseguita — e la copia
// di /offline nella CacheStorage dei dispositivi è rimasta quella VECCHIA.
// Misurato sull'emulatore Android contro la produzione appena rilasciata: in
// rete c'era la pagina nuova (267.987 byte, con `data-kv-elenco`), sul telefono
// la vecchia (252.415 byte, senza). La correzione non era arrivata a nessuno di
// quelli che avevano già usato l'app.
//
// L'IMPRONTA qui sotto è lo sha256 dei cinque file che compongono il documento
// /offline (page.tsx, ContenutoOffline.tsx, script-offline.ts,
// messages/{it,en}/offline.json). Il lock
// `__tests__/architecture/sw-versione-offline.test.ts` la ricalcola a ogni run:
// se qualcuno tocca la pagina senza passare di qui il gate diventa rosso e dice
// cosa fare. Quando la si aggiorna, si alza ANCHE `VERSIONE`: cambiare l'hash
// basta a far reinstallare il SW (i byte del file cambiano), ma solo il bump di
// `VERSIONE` cambia `CACHE_SHELL` e fa buttare ad `activate` la cache
// precedente, asset statici stantii compresi.
//
// v3 → v4: il bump vale per rilascio, non per modifica, e v3 È rilasciata —
// verificato il 2026-08-01 scaricando `https://app.kidville.it/sw.js`, byte per
// byte identico a questo file. Si alza perché cambia la STRATEGIA di cache: ogni
// voce scritta con la regola vecchia («cache-first sempre») è stata salvata con
// un criterio che non vale più, e la si butta tutta invece di fidarsi voce per
// voce. Costa un riscaricamento del guscio alla prima apertura con rete.
//
// 2026-08-02 — la pagina /offline cambia ancora (la staffetta fra lo script
// inline e React: l'elenco delle pagine usciva DOPPIO), e `VERSIONE` resta a
// v4. Non è una dimenticanza, è la stessa regola di due paragrafi fa applicata
// al caso opposto: il bump vale per RILASCIO, e v4 non è mai stata rilasciata —
// `git show main:public/sw.js` dice ancora `v3`. Sui telefoni là fuori c'è la
// cache v3, che `activate` butterà comunque appena questo file arriverà; un v5
// cancellerebbe una cache v4 che non esiste su nessun dispositivo. Ciò che
// serviva davvero — far reinstallare il Service Worker perché `precarica()`
// riscarichi /offline — lo fa l'impronta qui sotto, che cambia i BYTE del file.
//
// 2026-08-02 (secondo giro) — /offline cambia ancora: lo script inline non
// disegna più PRIMA dell'idratazione quando il bundle di Next è nel documento
// (era il React #418 a ogni apertura: il DOM che React trovava non era quello
// reso dal server). Stessa conclusione di sopra e per la stessa ragione:
// `VERSIONE` resta `v4` perché v4 non è ancora rilasciata — su `main` c'è v3 —
// e ciò che deve cambiare per far reinstallare il Service Worker sono i BYTE di
// questo file, che l'impronta qui sotto cambia da sé.
//
// 2026-08-02 (terzo giro) — /offline cambia ancora, stavolta solo nei TESTI: il
// titolo della scheda smette di essere cablato in italiano (in inglese il
// documento rendeva `<title>Kidville — nessuna connessione</title>` con
// `lang="en"` e il corpo tutto in EN) e il dizionario dei segmenti di rotta
// passa da 26 a 51 voci, così l'elenco delle pagine consultabili non cade più
// sul ripiego che capitalizza l'URL — in inglese si leggeva «Cucina» fra
// «Office home» e «Notices». `VERSIONE` resta `v4` per la stessa ragione dei
// due paragrafi sopra: v4 non è mai stata rilasciata, su `main` c'è ancora v3.
// Cambia l'impronta, cioè i BYTE di questo file, ed è quello che fa
// reinstallare il Service Worker e riscaricare /offline.
const VERSIONE = 'v4';
// IMPRONTA-PAGINA-OFFLINE: 5ca4f75fcf7bfc515934bdc990766e9fb9110a0f12ccb278c09c6501fa7e0bf9
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

/* ──────────────── mutabilità: chi può essere servito da cache ─────────────── */

/** Gli asset di build di Next: in produzione hanno l'hash nel nome, in dev no. */
const PREFISSO_STATICI_NEXT = '/_next/static/';

/**
 * Soglia oltre la quale un `max-age` vale quanto `immutable`: un giorno.
 * Nessuno mette 24 ore di cache su una risorsa che intende cambiare sotto lo
 * stesso URL; e se un domani Next smettesse di emettere `immutable` tenendo
 * `max-age=31536000`, gli asset con hash resterebbero cache-first senza che
 * nessuno debba accorgersene.
 */
const ETA_IMMUTABILE_MIN = 86400;

/** `Cache-Control` della risposta, minuscolo. Mai lancia: '' se non c'è. */
function direttiveCache(res) {
  try {
    const valore = res && res.headers ? res.headers.get('cache-control') : null;
    return valore ? valore.toLowerCase() : '';
  } catch {
    // Response senza `headers` utilizzabili (opaque, o un finto in un test):
    // si tratta come «non dichiara nulla», cioè non immutabile. È il verso
    // prudente: al massimo si va in rete una volta di troppo.
    return '';
  }
}

/**
 * La risposta dichiara che quell'URL identificherà per sempre questo contenuto?
 *
 * È l'UNICA condizione che rende corretto servire da cache senza sentire la
 * rete. `no-cache` significa «puoi conservarla ma devi rivalidarla»: per noi
 * vale come «non servirla da sola», ed è esattamente ciò che il dev server dice
 * dei suoi chunk.
 */
function immutabile(res) {
  const cc = direttiveCache(res);
  if (!cc) return false;
  if (cc.includes('no-store') || cc.includes('no-cache')) return false;
  if (cc.includes('immutable')) return true;
  const eta = cc.match(/max-age\s*=\s*(\d+)/);
  return !!eta && Number(eta[1]) >= ETA_IMMUTABILE_MIN;
}

/**
 * Si può SCRIVERE questa risposta nella cache del guscio?
 *
 * Due no:
 *  · `no-store` — il server chiede di non metterla su disco, e lo si rispetta;
 *  · `/_next/static/` non immutabile — è una build di sviluppo: lo stesso URL
 *    conterrà un file diverso alla prossima ricompilazione, quindi conservarlo
 *    non serve a nessuno (l'offline in sviluppo non è una cosa che esiste) e
 *    lascia in giro esche per il prossimo che collauda.
 * Tutto il resto si conserva: `/mascot.png` e le icone sono `max-age=0` anche in
 * produzione, e senza di loro il guscio offline si vedrebbe spoglio.
 */
function conservabile(url, res) {
  if (direttiveCache(res).includes('no-store')) return false;
  if (url.pathname.startsWith(PREFISSO_STATICI_NEXT) && !immutabile(res)) return false;
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

/**
 * Toglie dalla cache corrente gli asset di build che NON sono immutabili.
 *
 * Serve a bonificare quello che la regola vecchia ha già scritto: una macchina
 * di sviluppo che ha collaudato ieri si porta dentro `kidville-shell-*` i chunk
 * di Turbopack di ieri. Con la regola nuova non verrebbero comunque più serviti,
 * ma restare lì è un'esca: chi apre la CacheStorage li vede e non sa se sono
 * quelli che gli stanno rompendo la pagina. Il bump di `VERSIONE` fa lo stesso
 * lavoro solo quando qualcuno si ricorda di alzarlo; questo lo fa da sé, a ogni
 * attivazione.
 *
 * In produzione non tocca niente: lì sotto `/_next/static/` è tutto `immutable`.
 */
async function potaAssetStantii() {
  let potati = 0;
  try {
    const cache = await caches.open(CACHE_SHELL);
    const chiavi = await cache.keys();
    for (const req of chiavi) {
      let pathname;
      try {
        pathname = new URL(req.url).pathname;
      } catch {
        continue; // chiave non interpretabile: non è roba nostra, si lascia stare
      }
      if (!pathname.startsWith(PREFISSO_STATICI_NEXT)) continue;
      const salvata = await cache.match(req);
      if (salvata && immutabile(salvata)) continue;
      await cache.delete(req);
      potati += 1;
    }
  } catch {
    // Potatura fallita: nessun danno, gli asset non immutabili non vengono
    // comunque serviti da soli. Si continua con l'attivazione.
  }
  // Si riferisce solo quando c'è stato davvero qualcosa da buttare: è il segnale
  // «questo ambiente aveva copie stantie», non rumore a ogni avvio.
  if (potati > 0) avvisa('sw-asset-stantii-potati', 'warn', 'altro');
}

// install: pre-cacha la pagina di ripiego e attiva subito il nuovo SW.
self.addEventListener('install', function (event) {
  event.waitUntil(precarica());
  self.skipWaiting();
});

// activate: prende il controllo dei client aperti, elimina le cache di versioni
// precedenti (nome diverso da CACHE_SHELL), pota gli asset di build stantii
// rimasti in quella corrente e ri-precarica /offline — è il punto in cui si
// recupera un cambio di lingua avvenuto dopo l'installazione.
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
      await potaAssetStantii();
      await precarica();
    })()
  );
});

/* ───────────────────────────── strategie ─────────────────────────────────── */

/**
 * Serve un asset statico.
 *
 * Cache-first SOLO se la copia salvata si dichiara immutabile (vedi
 * `immutabile()`): è il caso dei chunk di produzione, il cui nome contiene
 * l'hash del contenuto. Tutto il resto è rete-prima: online si vede sempre la
 * copia fresca — è ciò che rende impossibile il chunk stantio in sviluppo —
 * e la copia salvata resta lì per quando la rete non c'è.
 *
 * Mai lancia: in caso di guasto totale rilancia alla rete grezza.
 */
async function assetStatico(request, url) {
  let salvata;
  try {
    salvata = await caches.match(request);
  } catch {
    // Cache non leggibile (storage disabilitato, modalità privata): si prosegue
    // come se non ci fosse nulla di salvato, cioè si va in rete.
    salvata = undefined;
  }
  if (salvata && immutabile(salvata)) return salvata;

  try {
    const res = await fetch(request);
    if (res && res.ok) {
      if (conservabile(url, res)) {
        try {
          const cache = await caches.open(CACHE_SHELL);
          await cache.put(request, res.clone());
        } catch {
          // put fallita (quota/opaque): si ignora, la risposta è già pronta.
        }
      } else if (salvata) {
        // C'era una copia scritta da una regola precedente e ora sappiamo che
        // non va conservata: si toglie subito, senza aspettare un `activate`.
        try {
          const cache = await caches.open(CACHE_SHELL);
          await cache.delete(request);
        } catch {
          // delete fallita: la voce resta, ma non verrà comunque più servita
          // (non è immutabile), quindi è innocua.
        }
      }
    }
    return res;
  } catch {
    // Qui la rete non c'è: la copia vecchia è meglio di un asset mancante.
    if (salvata) return salvata;
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
  if (url.pathname.startsWith(PREFISSO_STATICI_NEXT)) return true;
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
    event.respondWith(assetStatico(request, url));
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
