import { test, expect } from '@playwright/test';
import { EMAILS, login } from './fixtures';

// Login ok/ko per i 3 ruoli, redirect anonimo, API senza sessione → 401.
// Questo file NON usa storageState: ogni test parte da contesto pulito.

test('login ko: credenziali sbagliate mostrano l’errore', async ({ page }) => {
  await login(page, EMAILS.admin, 'password-sbagliata');
  // Filtro per testo: anche il route announcer di Next espone role="alert".
  await expect(
    page.getByRole('alert').filter({ hasText: 'Credenziali non valide' })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/login/);
});

test('login ok admin → /admin', async ({ page }) => {
  await login(page, EMAILS.admin);
  await page.waitForURL('**/admin');
  await expect(page.getByRole('heading', { name: 'Dashboard Direzione' })).toBeVisible();
});

test('login ok docente → /teacher', async ({ page }) => {
  await login(page, EMAILS.docente);
  await page.waitForURL('**/teacher');
  // Saluto dipendente dall'ora (Buongiorno/Buon pomeriggio/Buonasera): asserzione
  // tempo-indipendente sul saluto neutro renderizzato client-side.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buongiorno|Buon pomeriggio|Buonasera/);
});

test('login ok genitore → /parent', async ({ page }) => {
  await login(page, EMAILS.genitore);
  await page.waitForURL('**/parent');
  await expect(page.locator('main#content')).toBeVisible();
});

test('anonimo su /admin → redirect al login con next', async ({ page }) => {
  await page.goto('/admin');
  await page.waitForURL('**/auth/login?next=%2Fadmin');
  await expect(page.getByRole('button', { name: 'Accedi' })).toBeVisible();
});

test('anonimo su /parent → redirect al login con next', async ({ page }) => {
  await page.goto('/parent');
  await page.waitForURL('**/auth/login?next=%2Fparent');
});

test('API senza sessione → 401', async ({ request }) => {
  const me = await request.get('/api/me');
  expect(me.status()).toBe(401);
  const notifiche = await request.get('/api/notifiche');
  expect(notifiche.status()).toBe(401);
});
