import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Centro notifiche della AppBar genitore/docente (NotificationsPanel):
// badge non lette, dropdown, "Segna tutte lette". Mirror dello spec admin.

test.describe('genitore', () => {
  test.use({ storageState: STORAGE.genitore });

  test('badge non lette → dropdown → segna tutte lette', async ({ page }) => {
    await page.goto('/parent');

    const campanella = page.getByRole('button', { name: /Notifiche \(\d+ non lett/ });
    await expect(campanella).toBeVisible({ timeout: 15_000 });

    await campanella.click();
    await expect(page.getByText('Notifica genitore E2E')).toBeVisible();

    await page.getByRole('button', { name: 'Segna tutte lette' }).click();

    await expect(page.getByRole('button', { name: 'Notifiche', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Segna tutte lette' })).toHaveCount(0);
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
