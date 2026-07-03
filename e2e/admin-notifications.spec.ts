import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Centro notifiche admin: badge non lette, dropdown, "Segna tutte lette".
test.use({ storageState: STORAGE.admin });

test('badge non lette → dropdown → segna tutte lette', async ({ page }) => {
  await page.goto('/admin');

  // La notifica E2E seedata è non letta: l'aria-label espone il conteggio.
  const campanella = page.getByRole('button', { name: /Notifiche \(\d+ non lett/ });
  await expect(campanella).toBeVisible({ timeout: 15_000 });

  await campanella.click();
  await expect(page.getByText('Notifica E2E')).toBeVisible();

  await page.getByRole('button', { name: 'Segna tutte lette' }).click();

  // Dopo il PATCH il conteggio sparisce: aria-label torna "Notifiche" secco.
  await expect(page.getByRole('button', { name: 'Notifiche', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Segna tutte lette' })).toHaveCount(0);
});
