import { test, expect } from '@playwright/test'
import { IDS, STORAGE } from './fixtures'

// «Alunni» dell'insegnante: l'anagrafica dei PROPRI bambini, in sola lettura.
// Seed: `docente.e2e` insegna in «Girasoli» (Aurora Arcobaleno-E2E, Bruno Baleno-E2E);
// Clara Cometa-E2E sta in «Tulipani», che non è sua. Si usano i nomi del seed e non
// le frasi dei cataloghi (che cambiano).

test.describe('Docente — anagrafica dei propri alunni, in sola lettura', () => {
  test.use({ storageState: STORAGE.docente })

  test('elenco della propria sezione, ricerca per nome, scheda senza campi modificabili', async ({ page }) => {
    await page.goto('/teacher/alunni')
    const aurora = page.getByRole('link', { name: /^Arcobaleno-E2E Aurora/ })
    await expect(aurora).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toBeVisible()
    // Dopo una PRESENZA, l'assenza: Clara è di un'altra sezione.
    await expect(page.getByRole('link', { name: /Cometa-E2E/ })).toHaveCount(0)

    await page.getByRole('searchbox').fill('aurora')
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toHaveCount(0)
    await expect(aurora).toBeVisible()
    // La ricerca per nome non finisce mai nell'indirizzo.
    expect(new URL(page.url()).searchParams.get('q')).toBeNull()

    await aurora.click()
    await expect(page).toHaveURL(new RegExp(`/teacher/alunni/${IDS.A1}$`))
    const scheda = page.getByTestId('scheda-alunno')
    await expect(scheda.getByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeVisible({ timeout: 15_000 })
    await expect(scheda.locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0)
  })

  test('la scheda di un bambino di un’altra sezione è negata', async ({ page }) => {
    await page.goto(`/teacher/alunni/${IDS.A3}`)
    await expect(page.getByTestId('scheda-esito')).toHaveAttribute('data-esito', 'negata', { timeout: 15_000 })
    await expect(page.getByText('Cometa-E2E')).toHaveCount(0)
  })
})
