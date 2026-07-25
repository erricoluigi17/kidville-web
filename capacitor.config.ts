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
  },
  plugins: {
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
