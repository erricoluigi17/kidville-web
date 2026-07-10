import { test } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { ADMIN_ROUTES } from '../config/coverage-matrix';
import { Recorder, visit, readAppIds } from '../lib/harness';

// Copertura TOTALE cockpit Segreteria/Direzione (desktop). Sweep di ogni route
// della matrice: screenshot + findings (HTTP/console/funzionale).
test.describe('Copertura ADMIN — Segreteria', () => {
  test.use({ storageState: storagePath('segreteria'), viewport: { width: 1366, height: 900 } });

  test('segreteria · sweep completo cockpit', async ({ page }) => {
    test.setTimeout(240_000);
    const ids = readAppIds();
    const rec = new Recorder('copertura-segreteria', 'Segreteria');
    for (const r of ADMIN_ROUTES) {
      await visit(page, rec, { url: r.path, flusso: r.area, label: r.label, appId: ids['segreteria'] });
    }
    rec.save();
  });
});
