import { test, expect } from '@playwright/test';
import { conNotificaPropria, segnaTutteLette } from './helpers/notifica-propria';
import { IDS, STORAGE } from './fixtures';

// Centro notifiche della AppBar genitore/docente (NotificationsPanel):
// badge non lette, dropdown, "Segna tutte lette". Mirror dello spec admin.
// Il perché della notifica propria per ogni tentativo sta in `helpers/notifica-propria.ts`.

test.describe('genitore', () => {
  test.use({ storageState: STORAGE.genitore });

  test('badge non lette → dropdown → segna tutte lette', async ({ page }) => {
    await conNotificaPropria(IDS.GENITORE, async (db, id, titolo) => {
      await page.goto('/parent');
      await segnaTutteLette(page, db, id, titolo);
    });
  });
});

test.describe('docente', () => {
  test.use({ storageState: STORAGE.docente });

  test('la campanella docente apre il feed notifiche', async ({ page }) => {
    await page.goto('/teacher');

    const campanella = page.getByRole('button', { name: /Notifiche \(\d+ non lett/ });
    await expect(campanella).toBeVisible({ timeout: 15_000 });

    await campanella.click();
    await expect(page.getByText('Notifica docente E2E')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tutti gli avvisi →' })).toBeVisible();
  });
});
