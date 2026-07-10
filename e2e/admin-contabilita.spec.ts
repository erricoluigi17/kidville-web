import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Contabilità admin (Fase A branch feat/contabilita-merchandise): shell a
// viste deep-linkabili, KPI responsive, agenda scadenze. Le viste nuove
// (fiscale/solleciti/riconciliazione) degradano con grazia sul DB CI non
// migrato: qui si verifica che rendano il proprio empty-state, mai crash.
test.use({ storageState: STORAGE.admin });

test('lo scadenzario mostra KPI e agenda; le viste sono deep-linkabili', async ({ page }) => {
  await page.goto('/admin/pagamenti');
  await expect(page.getByRole('heading', { name: 'Contabilità' })).toBeVisible();

  // KPI (StatCard) — incluso il nuovo "Da fatturare"
  for (const label of ['Incassato', 'Da incassare', 'Da fatturare']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  }
  // Agenda scadenze: i 4 bucket di aging
  await expect(page.getByRole('button', { name: /Questa settimana/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Scaduti oltre 30gg/ })).toBeVisible();

  // Deep-link sulle viste nuove (empty-state graziosi su DB non migrato)
  await page.goto('/admin/pagamenti?vista=fiscale');
  await expect(page.getByText('Registro ricevute').first()).toBeVisible({ timeout: 15_000 });
  await page.goto('/admin/pagamenti?vista=solleciti');
  await expect(page.getByText('Solleciti di pagamento').first()).toBeVisible({ timeout: 15_000 });
  await page.goto('/admin/pagamenti?vista=riconciliazione');
  await expect(page.getByText('Riconciliazione bancaria').first()).toBeVisible({ timeout: 15_000 });
});

test('i KPI restano leggibili su viewport mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/pagamenti');
  await expect(page.getByText('Da fatturare', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Prossimi 30gg/ })).toBeVisible();
});
