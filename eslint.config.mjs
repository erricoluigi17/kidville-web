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
  ]),
]);

export default eslintConfig;
