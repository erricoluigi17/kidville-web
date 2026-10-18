import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { shaNormalizzato } from "./src/lib/versione/deploy";

/**
 * ─── LA VERSIONE DEL BUNDLE, COTTA IN BUILD ──────────────────────────────────
 *
 * `GET /api/versione` dice quale rilascio sta servendo il server ADESSO; questa costante dice
 * quale codice ha in mano il browser. Il confronto fra le due è ciò che permette all'app, al
 * ritorno in primo piano dopo molto tempo, di accorgersi che sta eseguendo un bundle vecchio
 * (`src/components/providers/ControlloVersione.tsx`).
 *
 * Perché passa da `env` e non da una variabile `NEXT_PUBLIC_*` impostata a mano: il valore
 * cambia a OGNI commit, quindi un valore scritto una volta sarebbe sbagliato dal secondo deploy
 * in poi. La fonte è `VERCEL_GIT_COMMIT_SHA`, che Vercel valorizza al momento della build; le
 * chiavi dichiarate qui vengono sostituite nel bundle del client esattamente come le
 * `NEXT_PUBLIC_*` (guida di Next 16.3, `03-api-reference/05-config/01-next-config-js/env.md`).
 *
 * `shaNormalizzato` è la STESSA funzione che usa la route: una seconda copia della regola che
 * taglia a 12 caratteri e abbassa le maiuscole renderebbe il confronto diverso per sempre, cioè
 * una ricarica a ogni ritorno in primo piano su ogni telefono.
 *
 * Fuori da Vercel (build locale, CI) la variabile non c'è: la chiave resta una stringa vuota,
 * `VERSIONE_BUNDLE` vale `null` e il controllo non parte affatto.
 */
const VERSIONE_BUNDLE = shaNormalizzato(process.env.VERCEL_GIT_COMMIT_SHA) ?? "";

/**
 * ─── HEADER DI SICUREZZA ─────────────────────────────────────────────────────
 *
 * Fino al 2026-08-01 le risposte dell'app non ne portavano NESSUNO: né CSP, né HSTS,
 * né `X-Frame-Options`, né `X-Content-Type-Options`, né `Referrer-Policy`, né
 * `Permissions-Policy` (collaudo del 2026-07-31, sicurezza W4).
 *
 * `Referrer-Policy` qui non è una formalità. `src/middleware.ts` spiega, per giustificare
 * il fatto che non logga il path grezzo, che «in questo repo il path È una credenziale»
 * — `/m/<token>` del modulo pubblico è una capability — e che «gli id dei minori sono
 * segmenti di rotta». Senza policy dichiarata, quel token e quegli uuid finiscono
 * nell'header `Referer` di ogni richiesta verso un'origine terza: la credenziale esce dal
 * perimetro senza che nessuno la mandi. `strict-origin-when-cross-origin` fa uscire la
 * sola origine, mai il percorso.
 *
 * Lock: `__tests__/architecture/header-sicurezza.test.ts`.
 */

/**
 * PERCHÉ LA CSP SI FERMA QUI.
 *
 * Mancano di proposito `default-src`, `script-src` e `frame-src`, e il lock pretende che
 * continuino a mancare finché non arriva il nonce.
 *
 *  · `script-src` seria vuole un **nonce per richiesta**: Next App Router emette gli script
 *    inline di bootstrap dell'idratazione, e in sviluppo usa `eval` per l'HMR. Un valore
 *    statico scritto qui non renderebbe l'app più sicura, la renderebbe bianca.
 *  · `default-src` porterebbe con sé `frame-src` per ereditarietà, spegnendo gli embed
 *    Instagram e i video della sezione News — che sono iframe verso origini terze — senza
 *    che nessun test unitario se ne accorga.
 *
 * Restano le direttive che chiudono una classe di attacco **senza fallback impliciti**:
 * incorniciamento (clickjacking sulla console di segreteria), `<base>` iniettato, plugin,
 * e form che postano verso un'altra origine.
 *
 * `frame-ancestors 'self'` e non `'none'`: `parent/news/digest/[id]` mostra l'edizione in
 * un `<iframe srcDoc>`, che è same-origin. `'none'` sarebbe un divieto che dipende da un
 * dettaglio di specifica (se la policy ereditata valga o no per i documenti `srcdoc`) —
 * e la difesa da clickjacking è identica: nessuna origine esterna può incorniciarci.
 */
const CSP = [
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

/**
 * HSTS senza `includeSubDomains` e senza `preload`, deliberatamente.
 *
 * `mail.kidville.it` è un SOTTODOMINIO usato per l'invio email (SPF/DKIM del provider).
 * `includeSubDomains` forzerebbe HTTPS su ogni sottodominio esistente e futuro, per due
 * anni e su ogni browser che ha visto l'header: un sottodominio servito in chiaro
 * diventerebbe irraggiungibile, in modo non diagnosticabile da chi non conosce HSTS.
 * `preload` è, in più, un impegno che si prende con Google e si revoca in mesi.
 * Entrambi si aggiungono quando qualcuno ha verificato l'elenco dei sottodomini — non
 * di sfuggita dentro un fix di header.
 */
const HSTS = 'max-age=31536000';

/**
 * Le funzioni del browser che l'app non usa restano spente.
 *
 * `camera=(self)` e non `()`: la fotocamera passa dal plugin NATIVO
 * (`@capacitor/camera`, che usa il codice della piattaforma e non `getUserMedia`), ma sul
 * web il ripiego è un `<input type="file" capture>`; `self` non toglie niente a nessuno e
 * non lascia comunque la funzione a un iframe terzo.
 *
 * L'elenco è corto di proposito: una feature non riconosciuta dal browser produce un
 * warning in console a ogni pagina, e i warning che non significano niente sono il modo
 * più efficace di far smettere di leggere la console.
 */
const PERMISSIONS = 'camera=(self), microphone=(), geolocation=(), payment=()';

const HEADER_SICUREZZA = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Strict-Transport-Security', value: HSTS },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: PERMISSIONS },
];

const nextConfig: NextConfig = {
  /* config options here */

  // La versione del rilascio dentro il bundle del browser (vedi `VERSIONE_BUNDLE` qui sopra).
  env: { NEXT_PUBLIC_VERSIONE_BUNDLE: VERSIONE_BUNDLE },

  async headers() {
    return [{ source: '/:path*', headers: HEADER_SICUREZZA }];
  },

  // Le linguette di Modulistica diventate pagine proprie. «Candidature» è uscita il 2026-10-17,
  // e il suo vecchio indirizzo è scritto nel `link` di ogni notifica `candidatura_ricevuta`
  // già spedita: senza questo rimando campanella e push aprirebbero «Moduli inviabili».
  // Le altre query del link passano alla destinazione (guida di Next, `redirects.md`), quindi
  // i filtri sopravvivono. Temporaneo e non 308: un permanente resta nella cache del browser.
  // Lock: `__tests__/architecture/linguette-trasferite-rimandano.test.ts`.
  async redirects() {
    return [
      {
        source: '/admin/modulistica',
        has: [{ type: 'query', key: 'tab', value: 'candidature' }],
        destination: '/admin/candidature',
        permanent: false,
      },
    ];
  },

  // ⚠️ NON aggiungere MAI `compiler: { removeConsole: true }` (né la sua variante
  // `{ exclude: [...] }`).
  //
  // L'intero sistema di osservabilità — `src/lib/logging/**` e `src/instrumentation.ts` —
  // emette su `console.log` / `console.error`: è così che le righe arrivano ai Runtime Logs
  // di Vercel. `removeConsole` le cancellerebbe IN PRODUZIONE e SOLO in produzione, in
  // silenzio: build verde, test verdi, e nessun log proprio nell'unico ambiente in cui
  // servono. È esattamente la forma di guasto che questo sistema esiste per impedire.
  //
  // Il rumore su console NON si combatte da qui, si combatte alla sorgente: la regola ESLint
  // `no-console` vieta `console.*` in `src/` (eccezioni: `src/lib/logging/**`,
  // `src/instrumentation.ts`, `src/middleware.ts`).
  //
  // Vedi docs/superpowers/specs/2026-07-12-logging-strutturato-design.md
};

// next-intl: legge la lingua dal cookie via src/i18n/request.ts (senza routing per-locale).
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
export default withNextIntl(nextConfig);
