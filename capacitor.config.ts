import type { CapacitorConfig } from '@capacitor/cli'

// Shell nativa Capacitor dell'app Kidville (milestone M10). Vedi docs/mobile.md.
//
// La WebView nativa carica l'app web da `server.url` (le API Next.js non sono
// impacchettabili in statico). L'URL arriva dall'env `CAP_SERVER_URL`:
//   - dev:   http://<ip-locale>:3000
//   - store: URL HTTPS pubblico del deploy (Vercel)
// Se CAP_SERVER_URL non e' impostata, la shell usa il fallback locale in webDir
// (mobile/www) — utile per una build che non deve puntare ad alcun server.
const serverUrl = process.env.CAP_SERVER_URL?.trim()

// `limitsNavigationsToAppBoundDomains` si accende SOLO contro il dominio di
// produzione. In sviluppo `CAP_SERVER_URL` è un IP di LAN, che non è un dominio
// registrabile e non può stare in `WKAppBoundDomains` (ios/App/App/Info.plist):
// accendere il flag lì renderebbe l'app un muro, perché nessuna navigazione
// sarebbe consentita. Conseguenza da conoscere: su iOS il Service Worker — e
// quindi l'offline — NON si collauda in dev su IP di LAN.
const appBound = !!serverUrl && serverUrl.startsWith('https://app.kidville.it')

const config: CapacitorConfig = {
  appId: 'it.kidville.app',
  appName: 'Kidville',
  webDir: 'mobile/www',
  // PRIVACY — questa riga chiude un canale di uscita dei dati, non è cosmesi.
  // Con il default `debug`, in una build di debug il bridge stampa nei log di
  // sistema il payload INTERO di ogni risposta nativa: durante il collaudo su
  // emulatore in logcat è finito il dataUrl base64 di una foto scattata, EXIF
  // compreso (`native-bridge.js` → `createLogFromNative` → `c.dir(JSON.stringify
  // (result.data))`), cioè l'immagine potenziale di un minore in chiaro.
  //
  // `'none'` e NON `'production'`: il nome inganna. Nel codice nativo
  // (CapConfig.java, CAPInstanceConfiguration.m) `production` significa «log
  // SEMPRE attivi, anche nelle build di rilascio» — applicarlo peggiorerebbe il
  // difetto. `none` è l'unico valore che chiude il canale.
  //
  // Chiave GLOBALE e non per-piattaforma: entrambe ricadono su questa, e due
  // chiavi sarebbero due posti in cui dimenticarsene.
  //
  // Effetto collaterale voluto: su Android spegne l'INTERO inoltro della console
  // della WebView verso logcat. Per il debug si usano `chrome://inspect`
  // (Android) e Safari → Sviluppo (iOS); il canale strutturato dell'app resta
  // `@/lib/logging/client` → /api/logs → tabella `app_log`, che è redatto.
  loggingBehavior: 'none',
  ios: {
    limitsNavigationsToAppBoundDomains: appBound,
    // Il fondo della finestra sotto la WebView. Finché il primo HTML non è
    // arrivato la WebView non dipinge nulla e si vede QUESTO: col default
    // bianco era il lampo chiaro fra lo splash e la pagina. Crema, cioè il
    // fondo che l'app ha comunque.
    backgroundColor: '#FEF1E4',
  },
  android: {
    backgroundColor: '#FEF1E4',
  },
  plugins: {
    // ── Lo splash che copre l'attesa della rete ──────────────────────────────
    //
    // IL PROBLEMA. Questa è una WebView che carica `app.kidville.it` DALLA RETE.
    // La schermata di lancio di iOS sparisce appena il processo è pronto, cioè
    // dopo qualche decimo di secondo; il primo HTML arriva secondi dopo. In
    // mezzo la WebView è vuota, e l'utente guarda uno schermo bianco. Il
    // `PageLoader` non può coprirlo: fa parte della pagina che si sta ancora
    // scaricando.
    //
    // COME SI CHIUDE. Lo splash nativo resta a schermo e lo toglie l'app web
    // quando è pronta (`nascondiSplashNativo`, chiamata da `setupNativeShell`).
    // L'immagine è identica al `PageLoader` — stesso crema, stesso lettering,
    // stessa misura — quindi lo scambio fra i due non si vede.
    //
    // PERCHÉ `launchAutoHide` RESTA `true`, che sembra il contrario di quel che
    // serve: è il TETTO, non il comportamento normale. Con `false` lo splash si
    // toglie **solo** da JavaScript, e basta un boot in cui il JS non arriva
    // mai — server lento che non risponde né fallisce, chunk che non carica —
    // perché l'app resti bloccata su una schermata fissa per sempre.
    //
    // I 6 SECONDI SONO UN COMPROMESSO, e vale la pena sapere fra cosa. Il tetto
    // non tocca il caso normale (l'app chiama `hide()` appena ha dipinto, dopo
    // 1-3 s), ma è esattamente ciò che si paga in MODALITÀ AEREO: lì il
    // caricamento fallisce in una frazione di secondo, la WebView passa a
    // `errorPath` (`offline.html`) — e quella pagina sta su un'origine locale,
    // dove il bridge di Capacitor potrebbe non essere iniettato, quindi
    // potrebbe non poter chiedere lei di togliere lo splash. Alzare il tetto
    // migliora le reti lente e peggiora l'offline, nella stessa misura.
    //
    // Ciò che rende accettabile il compromesso è il livello sotto: quando lo
    // splash se ne va, `backgroundColor` qui sopra fa trovare il CREMA, non il
    // bianco. Il caso peggiore non è più una schermata vuota: è la schermata
    // d'attesa senza il logo.
    SplashScreen: {
      launchShowDuration: 6_000,
      launchAutoHide: true,
      launchFadeOutDuration: 250,
      backgroundColor: '#FEF1E4',
      // Nessuna rotella: il `PageLoader` sotto ha già la sua animazione, e due
      // indicatori diversi in successione si leggono come un inciampo.
      showSpinner: false,
      // L'immagine è quadrata e lo schermo no: `CENTER_CROP` la scala finché
      // copre, tenendo il logo al centro. Il default `FIT_XY` la stirerebbe.
      androidScaleType: 'CENTER_CROP',
      // La barra di stato resta visibile: sparire e ricomparire fa saltare il
      // contenuto di qualche pixel proprio mentre lo splash si dissolve.
      splashFullScreen: false,
      splashImmersive: false,
    },
    PushNotifications: {
      // iOS: mostra banner/suono/badge ANCHE con l'app in foreground
      // (di default iOS sopprime le notifiche quando l'app è aperta).
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  server: {
    // Rete di ULTIMA istanza, ed è l'unica risposta possibile al caso che
    // nessun Service Worker può coprire: app appena installata, dispositivo
    // offline, SW mai registrato. Il file è locale (dentro webDir), quindi
    // arriva a destinazione anche con `server.url` remoto.
    // NOTA: su Android scatta anche sui 4xx/5xx di main frame, non solo quando
    // manca la rete — per questo il testo della pagina dice «non raggiungibile»
    // e non «sei offline».
    errorPath: 'offline.html',
    // Questa riga è ciò che tiene «Riprova» DENTRO l'app (rilievo T14-F2 del
    // collaudo Android 2026-08-03: il pulsante apriva app.kidville.it nel browser
    // di sistema, e l'utente usciva dall'app perdendo la sessione nativa).
    //
    // `offline.html` è servito dallo schema LOCALE (`https://localhost` su Android,
    // `capacitor://localhost` su iOS): la sua navigazione verso `app.kidville.it` è
    // fuori origine, e Capacitor la sottopone a una decisione che finisce in un
    // Intent verso Chrome / in `UIApplication.shared.open` —
    //   Android · Bridge.java:389-417   `!appAllowNavigationMask.matches(url.getHost())`
    //   iOS     · WebViewDelegationHandler.swift:95-115  `shouldAllowNavigation(to:)`
    // — a meno che l'host non sia dichiarato QUI. Senza questa voce la maschera è
    // `HostMask.Nothing`, e l'unica cosa che tratteneva l'utente dentro l'app era la
    // coincidenza fra l'URL cablato nella pagina e `server.url`: vera in produzione,
    // FALSA sull'emulatore (`10.0.2.2`) e falsa in una build senza `CAP_SERVER_URL`
    // (dove `appUrl` ripiega su `https://localhost`). Due configurazioni su tre
    // uscivano dall'app, ed è quella che il collaudo ha avuto in mano.
    //
    // Un host solo, scritto per esteso: `allowNavigation` non è una lista di comodo.
    // Ogni voce è un dominio che può caricarsi dentro la WebView dell'app, cioè con
    // accanto i cookie di sessione di un genitore e senza barra degli indirizzi; un
    // `*` qui trasformerebbe l'app in un browser aperto. I link esterni veri devono
    // continuare ad aprirsi fuori, ed è il comportamento che resta di default.
    //
    // Effetti collaterali verificati sul sorgente di Capacitor, perché non sono ovvi:
    // l'host finisce anche in `allowedOriginRules` e in `authorities`
    // (`Bridge.setAllowedOriginRules`). In produzione ci sono GIÀ entrambi — li mette
    // `server.url` (`Bridge.initWebView`, `authorities.add(appUrlObject.getAuthority())`).
    // In dev l'authority in più fa passare le richieste da `WebViewLocalServer
    // .handleProxyRequest`, che però esce subito con `null` quando `jsInjector == null`,
    // cioè su ogni WebView che supporti `DOCUMENT_START_SCRIPT` (Chrome 83+).
    // Il lock è in `__tests__/architecture/riprova-offline-resta-nella-webview.test.ts`.
    allowNavigation: ['app.kidville.it'],
    ...(serverUrl
      ? {
          url: serverUrl,
          // Consente il traffico HTTP in chiaro solo quando l'URL e' http://
          // (dev su IP locale); in produzione l'URL e' https e cleartext resta off.
          cleartext: serverUrl.startsWith('http://'),
        }
      : {}),
  },
}

export default config
