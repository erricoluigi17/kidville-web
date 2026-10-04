import { test, expect } from '@playwright/test'
import { IDS, STORAGE } from './fixtures'

// «Alunni» dell'insegnante: l'anagrafica dei PROPRI bambini, in sola lettura.
// Seed: `docente.e2e` insegna in «Girasoli» (Aurora Arcobaleno-E2E, Bruno Baleno-E2E);
// Clara Cometa-E2E sta in «Tulipani», che non è sua; Emma Eclissi-E2E è nella «Girasoli»
// omonima della SEDE 2 (fuori sede). Si usano i nomi del seed e non le frasi dei
// cataloghi (che cambiano).

// La CI E2E gira su `next dev` (playwright.config webServer): pagina e API compilano a
// FREDDO al primo accesso, e sotto carico runner può superare i 30 s (stessa misura di
// `teacher-attendance.spec.ts`). Timeout molto generosi accomodano il cold-compile senza
// cambiare cosa si asserisce: con `retries: 2` un timeout al primo tentativo diventerebbe
// un verde falso al terzo.
const PRIMO_CARICAMENTO = 60_000
test.describe.configure({ timeout: 150_000 })

const API_ELENCO = '/api/teacher/alunni'
const rispostaDi = (page: import('@playwright/test').Page, percorso: string) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === percorso, { timeout: PRIMO_CARICAMENTO })

test.describe('Docente — anagrafica dei propri alunni, in sola lettura', () => {
  test.use({ storageState: STORAGE.docente })

  test('elenco della propria sezione, ricerca per nome, scheda senza campi modificabili', async ({ page }) => {
    // L'attesa si imposta PRIMA dell'azione che fa partire la richiesta.
    const elenco = rispostaDi(page, API_ELENCO)
    await page.goto('/teacher/alunni')
    expect((await elenco).status()).toBe(200)

    const aurora = page.getByRole('link', { name: /^Arcobaleno-E2E Aurora/ })
    await expect(aurora).toBeVisible({ timeout: PRIMO_CARICAMENTO })
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toBeVisible()
    // Dopo una PRESENZA, l'assenza: Clara è di un'altra sezione, Emma di un'altra sede.
    await expect(page.getByRole('link', { name: /Cometa-E2E|Eclissi-E2E/ })).toHaveCount(0)

    await page.getByRole('searchbox').fill('aurora')
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toHaveCount(0)
    await expect(aurora).toBeVisible()
    // La ricerca per nome non finisce mai nell'indirizzo.
    expect(new URL(page.url()).searchParams.get('q')).toBeNull()
    expect(page.url()).not.toMatch(/aurora/i)

    const scheda = rispostaDi(page, `${API_ELENCO}/${IDS.A1}`)
    await aurora.click()
    await expect(page).toHaveURL(new RegExp(`/teacher/alunni/${IDS.A1}$`), { timeout: PRIMO_CARICAMENTO })
    expect((await scheda).status()).toBe(200)
    const corpo = page.getByTestId('scheda-alunno')
    await expect(corpo.getByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeVisible({ timeout: PRIMO_CARICAMENTO })
    await expect(
      corpo.locator('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'),
    ).toHaveCount(0)
  })

  test('la scheda di un bambino di un’altra sezione è negata', async ({ page }) => {
    const risposta = rispostaDi(page, `${API_ELENCO}/${IDS.A3}`)
    await page.goto(`/teacher/alunni/${IDS.A3}`)
    expect((await risposta).status()).toBe(403)
    await expect(page.getByTestId('scheda-esito')).toHaveAttribute('data-esito', 'negata', { timeout: PRIMO_CARICAMENTO })
    await expect(page.getByText('Cometa-E2E')).toHaveCount(0)
  })

  test('la scheda di un bambino di un’altra sede è negata', async ({ page }) => {
    const risposta = rispostaDi(page, `${API_ELENCO}/${IDS.B1}`)
    await page.goto(`/teacher/alunni/${IDS.B1}`)
    expect((await risposta).status()).toBe(403)
    await expect(page.getByTestId('scheda-esito')).toHaveAttribute('data-esito', 'negata', { timeout: PRIMO_CARICAMENTO })
    await expect(page.getByText('Eclissi-E2E')).toHaveCount(0)
  })
})
