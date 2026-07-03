import { test as setup } from '@playwright/test';
import { EMAILS, STORAGE, login } from './fixtures';

// Progetto "setup": login UI per i 3 ruoli → storageState riusati dagli spec.

setup('storageState admin', async ({ page }) => {
  await login(page, EMAILS.admin);
  await page.waitForURL('**/admin');
  await page.context().storageState({ path: STORAGE.admin });
});

setup('storageState docente', async ({ page }) => {
  await login(page, EMAILS.docente);
  await page.waitForURL('**/teacher');
  await page.context().storageState({ path: STORAGE.docente });
});

setup('storageState genitore', async ({ page }) => {
  await login(page, EMAILS.genitore);
  await page.waitForURL('**/parent');
  await page.context().storageState({ path: STORAGE.genitore });
});
