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
]);

export default eslintConfig;
