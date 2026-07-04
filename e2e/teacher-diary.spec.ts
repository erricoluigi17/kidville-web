import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Diario docente (/teacher/diary, sezione Girasoli): evento merenda + umore.
test.use({ storageState: STORAGE.docente });

async function mostraTuttiIBambini(page: import('@playwright/test').Page) {
  // Il filtro parte su "Solo presenti": passo a "Tutti" per non dipendere
  // dall'appello, attendendo il refetch degli alunni (il ripristino dello
  // stato salvato usa la lista corrente: senza attesa correrebbe in gara).
  const toggle = page.getByRole('button', { name: 'Solo presenti' });
  if (await toggle.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/diary/students') && r.status() === 200
      ),
      toggle.click(),
    ]);
  }
}

test('diario: salva merenda e umore, con persistenza', async ({ page }) => {
  await page.goto('/teacher/diary');

  await expect(page.getByRole('heading', { name: 'Diario del giorno' })).toBeVisible();
  await expect(page.getByText('Cosa vuoi registrare?')).toBeVisible({ timeout: 15_000 });
  await mostraTuttiIBambini(page);

  // Evento Merenda: i pannelli per bambino compaiono dopo la scelta del tipo.
  await page.getByRole('button', { name: 'Registra Merenda' }).click();
  await expect(page.getByText('Aurora').first()).toBeVisible();
  // Le quantità sono simboli: ✗ ¼ ½ ¾ ★ (★ = "Tutto!"), prima riga = Aurora.
  await page.getByRole('button', { name: '★' }).first().click();
  await page.getByRole('button', { name: /Salva Merenda per tutti/ }).click();
  await expect(page.getByText('✅ Salvato con successo!')).toBeVisible();

  // Umore (tile attiva via diario_config della scuola E2E): Aurora → Felice.
  await page.getByRole('button', { name: 'Registra Umore' }).click();
  await page.getByRole('button', { name: 'Aurora: Felice' }).click();
  await page.getByRole('button', { name: /Salva Umore per tutti/ }).click();
  await expect(page.getByText('✅ Salvato con successo!')).toBeVisible();

  // Persistenza: al reload la selezione umore viene ripristinata da Supabase.
  await page.reload();
  await expect(page.getByText('Cosa vuoi registrare?')).toBeVisible({ timeout: 15_000 });
  await mostraTuttiIBambini(page);
  await page.getByRole('button', { name: 'Registra Umore' }).click();
  await expect(page.getByRole('button', { name: 'Aurora: Felice' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
