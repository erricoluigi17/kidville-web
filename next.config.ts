import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

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

export default nextConfig;
