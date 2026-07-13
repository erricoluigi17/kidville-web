import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Progetti nativi Capacitor (M10): sorgenti native + shim Cordova vendorizzati
    // (ios/**/public/cordova.js ecc.) non vanno lintati dal gate del repo.
    "ios/**",
    "android/**",
    // Harness one-off del test 360° Primaria (script Playwright + tooling): non
    // è codice applicativo spedito, gira solo su richiesta. Escluso dal gate.
    "e2e/primaria-360/**",
    // Le sessioni parallele di Claude Code creano i propri worktree qui dentro:
    // COPIE COMPLETE del repo, su un ALTRO branch. Senza questa esclusione il gate
    // di questo branch fallisce per il codice di un branch diverso — e chi legge il
    // rosso non ha modo di capire che non è suo. (Stessa esclusione in vitest.config.ts.)
    ".claude/**",
  ]),

  /**
   * `no-console` su src/: un `console.*` diretto è un BYPASS dell'osservabilità, non una
   * scorciatoia innocua. Salta la redazione (e qui i dati sono di minori: allergie, diagnosi,
   * valutazioni), salta il contesto della richiesta (nessun requestId, nessun utente: la riga
   * non si correla con nient'altro), e non arriva mai in `app_log` — cioè evapora dopo un
   * giorno e non si può né contare né interrogare. Si passa da `@/lib/logging/logger`.
   *
   * `error` e non `warn`: la CI gira con `--max-warnings 0`, quindi un warning sarebbe già un
   * fallimento — ma con un messaggio che non dice che è una violazione, e dopo un po' si
   * imparerebbe a ignorarlo.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-console": "error" },
  },
  /**
   * Le uniche eccezioni, e ognuna ha una ragione che non si applica alle altre:
   *  · src/lib/logging/** È il logger: è l'unico posto autorizzato a scrivere su console,
   *    perché è il posto in cui la redazione e il contesto vengono applicati;
   *  · src/middleware.ts gira su EDGE, dove il logger (node:async_hooks, node:crypto) non è
   *    caricabile: lì la riga logfmt si scrive a mano;
   *  · src/instrumentation.ts è la RETE DI SICUREZZA — deve poter parlare anche quando è il
   *    logger stesso ad essere rotto, ed è bundlato anche per l'Edge.
   */
  {
    files: [
      "src/lib/logging/**/*.{ts,tsx}",
      "src/instrumentation.ts",
      "src/instrumentation-client.ts",
      "src/middleware.ts",
    ],
    rules: { "no-console": "off" },
  },
]);

export default eslintConfig;
