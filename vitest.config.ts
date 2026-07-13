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
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
