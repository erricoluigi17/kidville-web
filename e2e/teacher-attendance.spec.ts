import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Appello docente (/teacher/attendance, sezione Girasoli): registrazione + rettifica + persistenza.
test.use({ storageState: STORAGE.docente });

// La CI E2E gira su `next dev` (playwright.config webServer): la pagina appello è il
// PRIMO test a colpire /teacher/attendance + /api/diary/students + /api/attendance/*,
// che compilano a FREDDO. Sotto carico runner questo cold-compile può superare i 30s
// (la pagina resta su "Caricamento alunni da anagrafica…"; i fetch hanno .catch, non
// si impiantano → è solo lentezza di compile). Timeout molto generosi + test-timeout
// esplicito accomodano il cold-compile senza cambiare cosa si asserisce.
const RENDER = 60_000;
const AZIONE = 20_000;

test('appello: registra, rettifica assente→presente e persiste al reload', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Bruno')).toBeVisible({ timeout: RENDER });

  // Aurora presente: i 3 bottoni NON spariscono. Il bottone selezionato passa ad
  // aria-pressed="true" e compaiono le azioni di uscita.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A1}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: AZIONE });

  // Bruno assente: i bottoni restano tutti visibili; assente è attivo, presente non lo è.
  await page.locator(`#btn-assente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-assente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'false', { timeout: AZIONE });

  // Sezione completa: 2/2 registrati.
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });

  // Rettifica: Bruno da assente a presente, direttamente sul bottone (nessun reset intermedio).
  await page.locator(`#btn-presente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.locator(`#btn-assente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'false', { timeout: AZIONE });
  await expect(page.locator(`#btn-checkout-${IDS.A2}`)).toBeVisible({ timeout: AZIONE });

  // Persistenza reale (upsert su presenze): al reload gli stati, rettifica inclusa, restano.
  await page.reload();
  await expect(page.locator(`#btn-presente-${IDS.A1}`)).toHaveAttribute('aria-pressed', 'true', { timeout: RENDER });
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: AZIONE });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveAttribute('aria-pressed', 'true', { timeout: AZIONE });
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });
});

/**
 * La RETTIFICA DELL'ORARIO — l'ora d'ingresso si corregge, e persiste.
 *
 * Fino al 2026-09-07 nel nido e nell'infanzia l'orario era testo in sola lettura: il
 * registro scriveva l'ora del TOCCO e non c'era modo di dire che il bambino era
 * arrivato alle 09:40 e non alle 10:15.
 *
 * ⚠️ Il caso che conta davvero è l'ULTIMO: si corregge l'ingresso di un bambino che ha
 * ANCHE l'orario d'uscita, e si verifica che l'uscita non sia sparita. La strada corta
 * (riusare `handleSetStato`, cioè la POST) l'avrebbe azzerata — la POST è un upsert
 * della riga intera. È il difetto che questo test esiste per impedire.
 */
test('appello: l\'ora d\'ingresso si corregge, e non cancella quella d\'uscita', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: RENDER });

  // Presente → l'orario d'ingresso nasce (l'ora del tocco) e diventa un comando.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  const chipEntrata = page.locator(`#btn-orario-entrata-${IDS.A1}`);
  await expect(chipEntrata).toBeVisible({ timeout: AZIONE });

  // Si tocca: al suo posto compare il campo ora, pre-riempito con l'ora ITALIANA.
  await chipEntrata.click();
  const campo = page.locator(`#input-orario-entrata-${IDS.A1}`);
  await expect(campo).toBeVisible({ timeout: AZIONE });
  await campo.fill('09:10');
  await page.locator(`#btn-salva-orario-entrata-${IDS.A1}`).click();
  await expect(chipEntrata).toContainText('09:10', { timeout: AZIONE });

  // Persistenza vera (PATCH su presenze): al reload l'ora corretta è ancora lì.
  await page.reload();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('09:10', { timeout: RENDER });

  // ── E ORA IL CASO CHE VALE IL TEST ──────────────────────────────────────────
  // Uscita anticipata: il bambino ha ENTRAMBI gli orari.
  await page.locator(`#btn-uscita-${IDS.A1}`).click();
  const chipUscita = page.locator(`#btn-orario-uscita-${IDS.A1}`);
  await expect(chipUscita).toBeVisible({ timeout: AZIONE });
  const uscitaPrima = (await chipUscita.textContent()) ?? '';

  // Si corregge l'INGRESSO. L'uscita non deve muoversi di un minuto.
  await page.locator(`#btn-orario-entrata-${IDS.A1}`).click();
  await page.locator(`#input-orario-entrata-${IDS.A1}`).fill('08:35');
  await page.locator(`#btn-salva-orario-entrata-${IDS.A1}`).click();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('08:35', { timeout: AZIONE });
  await expect(chipUscita).toHaveText(uscitaPrima, { timeout: AZIONE });

  // E resta vero dopo un giro dal database.
  await page.reload();
  await expect(page.locator(`#btn-orario-entrata-${IDS.A1}`)).toContainText('08:35', { timeout: RENDER });
  await expect(page.locator(`#btn-orario-uscita-${IDS.A1}`)).toHaveText(uscitaPrima, { timeout: AZIONE });
});
