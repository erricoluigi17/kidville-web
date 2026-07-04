import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Home genitore: card seedate (avvisi, agenda, pagamenti) + flusso locker "Avvisa".
test.use({ storageState: STORAGE.genitore });

test('la home mostra il saluto e le card seedate', async ({ page }) => {
  await page.goto('/parent');

  // Il nome del figlio (Aurora) arriva da /api/parent/students → /api/diary/students.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Aurora', {
    timeout: 15_000,
  });

  // Card avvisi: l'avviso adesione seedato ha priorità massima nella preview.
  await expect(page.getByText('Avviso E2E: uscita al parco')).toBeVisible();
  await expect(page.getByText('Richiede adesione').first()).toBeVisible();

  // Agenda: evento futuro seedato per la sezione Girasoli.
  await expect(page.getByText('Prossimi appuntamenti')).toBeVisible();
  await expect(page.getByText('Gita al museo E2E')).toBeVisible();
  await expect(page.getByText('Uscita · ore 09:30')).toBeVisible();

  // Pagamenti: la retta aperta seedata (150 €).
  await expect(page.getByText('Totale da saldare')).toBeVisible();
  await expect(page.getByText('€ 150.00')).toBeVisible();
});

test('locker: "Avvisa" invia la segnalazione e mostra il toast', async ({ page }) => {
  await page.goto('/parent');

  // Scorta seedata sotto soglia rossa (stock 1) → riga Pannolini con bottone Avvisa.
  await expect(page.getByText('Pannolini')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1 pz')).toBeVisible();

  await page.getByRole('button', { name: 'Avvisa' }).click();
  await expect(
    page.getByText('Avviso inviato alla scuola per pannolini.')
  ).toBeVisible();
});
