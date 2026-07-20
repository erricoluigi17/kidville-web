import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Contabilità admin (Fase A branch feat/contabilita-merchandise): shell a
// viste deep-linkabili, KPI responsive, agenda scadenze. Le viste nuove
// (fiscale/solleciti/riconciliazione/cassa) degradano con grazia sul DB CI non
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

// Modulo «Cassa» (branch feat/cassa): tab dentro Contabilità. Sul DB E2E non
// migrato le tabelle cassa non esistono → il pannello mostra l'empty-state
// «Modulo cassa non ancora attivo»; su un DB migrato mostrerebbe le StatCard.
// Si accetta l'una O l'altra, mai un crash della pagina.
test('la vista Cassa è deep-linkabile e degrada con grazia (empty-state o StatCard)', async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/admin/pagamenti?vista=cassa');
  await expect(page.getByRole('heading', { name: 'Contabilità' })).toBeVisible();

  // La tab «Cassa» risulta quella ATTIVA (pill con aria-pressed=true).
  await expect(page.getByRole('button', { name: 'Cassa', pressed: true }).first()).toBeAttached({ timeout: 15_000 });

  // Il pannello rende: empty-state (DB non migrato) OPPURE la StatCard admin.
  const emptyState = page.getByText(/Modulo cassa non ancora attivo/i);
  const statCard = page.getByText('Saldo atteso in cassa', { exact: true });
  await expect(emptyState.or(statCard).first()).toBeVisible({ timeout: 15_000 });

  // La degradazione non è un crash: nessuna eccezione JS non catturata.
  expect(erroriPagina).toEqual([]);
});

test('la pill «Cassa» è visibile e cliccabile su viewport mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/pagamenti');

  const pill = page.getByRole('button', { name: 'Cassa' }).first();
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await pill.click();

  await expect(page).toHaveURL(/vista=cassa/);
  const emptyState = page.getByText(/Modulo cassa non ancora attivo/i);
  const statCard = page.getByText('Saldo atteso in cassa', { exact: true });
  await expect(emptyState.or(statCard).first()).toBeVisible({ timeout: 15_000 });
});
