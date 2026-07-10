import { test } from '@playwright/test';
import { DOCENTI, storagePath } from '../config/accounts';
import { TEACHER_ROUTES } from '../config/coverage-matrix';
import { Recorder, visit, readAppIds } from '../lib/harness';

// Copertura TOTALE area docente (mobile 390×844) per tutti e 5 i docenti.
test.describe.configure({ mode: 'parallel' });

for (const acc of DOCENTI) {
  test.describe(`Copertura DOCENTE — ${acc.label}`, () => {
    test.use({ storageState: storagePath(acc.key), viewport: { width: 390, height: 844 } });

    test(`${acc.key} · sweep completo`, async ({ page }) => {
      test.setTimeout(180_000);
      const ids = readAppIds();
      const rec = new Recorder(`copertura-${acc.key}`, acc.label);
      for (const r of TEACHER_ROUTES) {
        await visit(page, rec, { url: r.path, flusso: r.area, label: r.label, appId: ids[acc.key] });
      }
      rec.save();
    });
  });
}
