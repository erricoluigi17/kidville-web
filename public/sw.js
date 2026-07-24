// Service Worker — Web Push notifiche Kidville (modulo Pagamenti)
// + cache offline del guscio app (statici + navigazioni) per web e nativo.

// Nome versionato della cache: cambiarlo (v1 → v2) invalida il guscio vecchio
// in fase di `activate`. I DATI dinamici (avvisi/diario/menu) NON passano di qui:
// li gestisce Dexie a livello applicativo (read-cache), così non si serve mai una
// risposta API stantia dal Service Worker.
const CACHE_SHELL = 'kidville-shell-v1';

// install: attiva subito il nuovo SW senza aspettare la chiusura delle tab.
self.addEventListener('install', function () {
  self.skipWaiting();
});

// activate: prende il controllo dei client aperti ed elimina le cache di versioni
// precedenti (nome diverso da CACHE_SHELL). Tutto in try/catch: un errore qui non
// deve impedire l'attivazione.
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
    })()
  );
});

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

// Serve una navigazione network-first: prova la rete (e aggiorna la cache), con
// fallback all'ultima copia del documento se offline. Così l'app si apre offline.
async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      try {
        const cache = await caches.open(CACHE_SHELL);
        await cache.put(request, res.clone());
      } catch {
        // put fallita: ininfluente.
      }
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Nessuna copia: rilancia la rete così il browser mostra il suo errore offline.
    return fetch(request);
  }
}

function isStaticAsset(url) {
  if (url.pathname.startsWith('/_next/static/')) return true;
  return /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i.test(url.pathname);
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
  if (url.pathname.startsWith('/api/')) return;     // dati dinamici: sempre rete

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
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
