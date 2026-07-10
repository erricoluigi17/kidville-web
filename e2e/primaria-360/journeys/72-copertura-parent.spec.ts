import { test } from '@playwright/test';
import { GENITORI, storagePath } from '../config/accounts';
import { PARENT_ROUTES } from '../config/coverage-matrix';
import { Recorder, visit, readAppIds } from '../lib/harness';

// Copertura area genitore (mobile 390×844) per tutte e 20 le personas (madre+padre
// dei 10 alunni). Sweep COMPLETO per un campione rappresentativo (madre+padre di
// Alunno1/2/3) → screenshot per l'ispezione visiva; sweep LEGGERO (route chiave)
// per le altre 14 personas → prova scoping/no-errori con meno screenshot.
test.describe.configure({ mode: 'parallel' });

const FULL_KEYS = new Set(['genitore1', 'genitore1p', 'genitore2', 'genitore2p', 'genitore3', 'genitore3p']);
const LIGHT_PATHS = new Set([
  '/parent', '/parent/primaria', '/parent/primaria/valutazioni', '/parent/primaria/note',
  '/parent/primaria/orario', '/parent/primaria/assenze', '/parent/compiti', '/parent/mensa',
  '/parent/avvisi', '/parent/chat', '/parent/pagamenti',
]);

for (const acc of GENITORI) {
  const full = FULL_KEYS.has(acc.key);
  test.describe(`Copertura GENITORE — ${acc.label}`, () => {
    test.use({ storageState: storagePath(acc.key), viewport: { width: 390, height: 844 } });

    test(`${acc.key} · sweep ${full ? 'completo' : 'leggero'} (Alunno${acc.studentN})`, async ({ page }) => {
      test.setTimeout(180_000);
      const ids = readAppIds();
      const rec = new Recorder(`copertura-${acc.key}`, acc.label);
      const routes = full ? PARENT_ROUTES : PARENT_ROUTES.filter((r) => LIGHT_PATHS.has(r.path));
      for (const r of routes) {
        await visit(page, rec, { url: r.path, flusso: r.area, label: r.label, appId: ids[acc.key] });
      }
      rec.save();
    });
  });
}
