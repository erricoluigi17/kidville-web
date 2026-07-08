import { test, expect } from '@playwright/test';
import { storagePath, SECTION_1A } from '../config/accounts';
import { readAppIds } from '../lib/harness';

// BUCKET D — medi UI/i18n (E19 DateField gg/mm/aaaa, E23 banner ClasseShell).
test.describe('BUCKET D — medi UI/i18n', () => {
  test.describe('segreteria', () => {
    test.use({ storageState: storagePath('segreteria') });

    test('E19: il report cucina usa il DateField italiano (placeholder gg/mm/aaaa)', async ({ page }) => {
      const uid = readAppIds()['segreteria'];
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
      await page.goto(`/admin/mensa/cucina?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      // Il DateField mostra il placeholder italiano, non un input date nativo mm/dd/yyyy.
      await expect(page.getByPlaceholder('gg/mm/aaaa').first()).toBeVisible({ timeout: 20000 });
      expect(errors, `pageerror report cucina: ${errors.join(' | ')}`).toEqual([]);
    });

    test('E23: banner "selettore docente" solo su Panoramica, non sulle tab', async ({ page }) => {
      const uid = readAppIds()['segreteria'];

      // Su una tab interna (Registro) il banner NON deve comparire.
      await page.goto(`/admin/primaria/${SECTION_1A}/registro?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await expect(page.getByText(/selettore del docente/i)).toHaveCount(0);

      // Sulla Panoramica (indice sezione) il banner compare UNA volta.
      await page.goto(`/admin/primaria/${SECTION_1A}?userId=${uid}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/selettore del docente/i).first()).toBeVisible({ timeout: 20000 });
    });
  });
});
