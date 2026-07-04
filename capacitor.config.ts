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

const config: CapacitorConfig = {
  appId: 'it.kidville.app',
  appName: 'Kidville',
  webDir: 'mobile/www',
  ...(serverUrl
    ? {
        server: {
          url: serverUrl,
          // Consente il traffico HTTP in chiaro solo quando l'URL e' http://
          // (dev su IP locale); in produzione l'URL e' https e cleartext resta off.
          cleartext: serverUrl.startsWith('http://'),
        },
      }
    : {}),
}

export default config
