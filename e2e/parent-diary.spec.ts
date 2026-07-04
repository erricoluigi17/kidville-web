import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Diario genitore: navigatore del giorno, banner umore e timeline seedata.
test.use({ storageState: STORAGE.genitore });

test('il diario di oggi mostra umore e attività seedati', async ({ page }) => {
  await page.goto('/parent/diary');

  await expect(page.getByRole('heading', { name: 'Il mio diario' })).toBeVisible();
  await expect(page.getByText('Oggi', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Banner umore (evento tipo_evento='umore', dettagli.umore='felice').
  await expect(page.getByText('Umore della giornata: Felice')).toBeVisible();
  await expect(page.getByText('Oggi sono stato/a proprio felice!')).toBeVisible();

  // Timeline: card Attività con la nota libera per i genitori.
  await expect(page.getByText('Attività', { exact: true })).toBeVisible();
  await expect(page.getByText('Nota E2E per i genitori')).toBeVisible();
});
