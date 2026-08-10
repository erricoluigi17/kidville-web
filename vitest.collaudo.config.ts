import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Configurazione per i COLLAUDI MANUALI su dati veri — separata dalla suite, e deve restarlo.
 *
 * ─── PERCHÉ ESISTE UN SECONDO FILE INVECE DI UN INTERRUTTORE NEL PRIMO ──────────────
 * `vitest.config.ts` fa due cose che qui servono ROVESCIATE:
 *   · impone `SUPABASE_URL` a `localhost` e una chiave di servizio finta;
 *   · carica `test/setup.ts`, che BLOCCA ogni `fetch` verso l'host di produzione.
 * Sono difese giuste e non si toccano: esistono perché un test unitario non deve poter
 * leggere, nemmeno per sbaglio, il database con i dati reali dei minori. Un collaudo che
 * legge la produzione è invece un atto DELIBERATO, che si lancia a mano e si guarda mentre
 * gira. Mettere una via di fuga dentro `vitest.config.ts` avrebbe reso aggirabile la
 * guardia da qualunque test; tenere i due mondi in due file la lascia inaggirabile da lì.
 *
 * ─── PERCHÉ I FILE NON SI CHIAMANO `.test.ts` ──────────────────────────────────────
 * L'`include` predefinito di vitest raccoglie ogni file che finisce per `.test.ts` o
 * `.spec.ts`, in qualunque cartella: un collaudo chiamato così
 * verrebbe raccolto anche da `npx vitest run` — cioè dal gate e dalla CI — e sbatterebbe
 * contro la guardia (o, peggio, la supererebbe). Con `.collaudo.ts` questo non può
 * accadere: la suite non lo vede, e questo file lo include per nome.
 *
 * ─── COME SI ESEGUE ────────────────────────────────────────────────────────────────
 *   COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts
 *
 * Le credenziali arrivano da `.env.local` (lette dal collaudo stesso, mai stampate).
 * Nessun collaudo scrive sul database né invia documenti: solo SELECT e generazione in
 * memoria.
 */
export default defineConfig({
  test: {
    // `node` e non `jsdom`: gli aiutanti che caricano gli XSD risolvono i percorsi con
    // `fileURLToPath(import.meta.url)`, e sotto jsdom `import.meta.url` non è un URL di file.
    environment: 'node',
    globals: true,
    include: ['scripts/collaudo/**/*.collaudo.ts'],
    // Nessun `setupFiles`: il collaudo DEVE poter parlare con la produzione.
    // Nessun `env`: i valori veri li legge il collaudo da `.env.local`.
    testTimeout: 180_000,
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
