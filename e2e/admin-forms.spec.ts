import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Compilazioni ricevute: dettaglio + toggle "Segna gestita" (PATCH reale).
test.use({ storageState: STORAGE.admin });

test('la compilazione seedata viene segnata come gestita', async ({ page }) => {
  await page.goto('/admin/forms/submissions');

  await expect(page.getByText('Compilazioni Ricevute')).toBeVisible();

  // Riga della submission seedata (il titolo compare anche come <option>
  // nascosta nel filtro modelli: tengo solo gli elementi visibili).
  const riga = page.getByText('Modulo E2E Gita').filter({ visible: true }).first();
  await expect(riga).toBeVisible({ timeout: 15_000 });
  await riga.click();

  // Sidebar di dettaglio → azione "Segna gestita".
  const bottone = page.getByRole('button', { name: 'Segna gestita' });
  await expect(bottone).toBeVisible();
  await bottone.click();

  // Il PATCH deriva gestita_il server-side: il bottone diventa "Gestita".
  await expect(page.getByRole('button', { name: /^Gestita/ })).toBeVisible();
  await expect(page.getByText('Gestita', { exact: true }).first()).toBeVisible();
});
