import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // `.claude/**` non è una svista: le sessioni parallele di Claude Code creano i propri
    // worktree lì dentro (`.claude/worktrees/<branch>/`), che sono COPIE COMPLETE del repo —
    // test compresi. Senza questa esclusione una `vitest run` esegue anche i test di un ALTRO
    // branch, e il gate diventa rosso (o verde) per codice che non è quello che si sta per
    // rilasciare: il modo più efficace che esista di non fidarsi più dei propri test.
    exclude: [...configDefaults.exclude, 'e2e/**', 'ios/**', 'android/**', '.claude/**'],
    /**
     * ⚠️ IL BERSAGLIO DELLA SUITE NON PUÒ ESSERE LA PRODUZIONE (2026-08-03).
     *
     * `src/lib/supabase/public-config.ts` risolve `SUPABASE_URL` con un RIPIEGO HARD-CODED sul
     * progetto di produzione — e quel ripiego serve, in produzione, per la ragione scritta lì
     * (le `NEXT_PUBLIC_*` su Vercel si sono rivelate fragili). Ma è una `const` valutata
     * all'IMPORT del modulo, e sotto vitest `.env.local` NON viene caricato: misurato il
     * 2026-08-03, `process.env.NEXT_PUBLIC_SUPABASE_URL` è **assente** dentro i test. Quindi
     * ogni route che costruiva un client dal factory puntava a
     * `https://uimulkjyekgemjakmepp.supabase.co` — il database con 227 domande d'iscrizione e
     * 152 codici fiscali di minori.
     *
     * I test che «dirottavano su localhost» scrivendo `process.env` nel `beforeEach` arrivavano
     * TROPPO TARDI: il modulo era già stato valutato all'import. Qui invece il valore esiste
     * prima di qualunque import, che è l'unico momento in cui serve.
     *
     * `SUPABASE_SERVICE_ROLE_KEY` è finta di proposito: finché è finta, una chiamata che
     * sfuggisse comunque verso la produzione verrebbe rifiutata. Non è la difesa — è l'ultima.
     * La difesa è la guardia su `globalThis.fetch` in `test/setup.ts`, e il lock che la misura è
     * `__tests__/architecture/nessun-bersaglio-di-produzione.test.ts`.
     *
     * NON si tocca `public-config.ts` per farlo: il ripiego lì è codice di produzione.
     */
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'chiave-anon-finta-di-test',
      SUPABASE_SERVICE_ROLE_KEY: 'chiave-di-servizio-finta-di-test',
    },
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
