import { test, expect, type Page } from '@playwright/test'
import { IDS, STORAGE } from './fixtures'

/**
 * «Candidature» — la pagina propria (2026-10-17) e il dettaglio che resta dov'è.
 *
 * Il difetto da cui nasce: aprendo il cinquantesimo curriculum, il dettaglio compariva IN CIMA
 * alla colonna destra (e il `focus()` sul titolo faceva risalire la pagina fin lassù); sul
 * telefono finiva sotto tutto l'elenco. Nessun test unitario vede una posizione a schermo:
 * jsdom non impagina. Qui si misura nel browser vero.
 *
 * Le API si rispondono da qui, con candidature FINTE (nessun dato reale): il DB della CI non ha
 * candidature, e l'impaginazione non dipende da cosa contengono. `serviceWorkers: 'block'`
 * perché il Service Worker aggira `page.route` (`.claude/rules/test.md`, trappola 4).
 */
test.use({ storageState: STORAGE.admin, serviceWorkers: 'block' })

const SEDE = IDS.SCUOLA
const TOTALE = 60

function uuid(i: number) {
  return `cafe0000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

const RIGHE = Array.from({ length: TOTALE }, (_, i) => ({
  id: uuid(i + 1),
  scuola_id: SEDE,
  stato: 'pending',
  nome: `Prova${i + 1}`,
  cognome: 'Candidata',
  posizioni: ['insegnante_infanzia'],
  gradi: ['infanzia'],
  creata_il: '2026-10-01T09:00:00Z',
  candidature_sedi: [{ scuola_id: SEDE, stato: 'pending' }],
}))

function dettaglioDi(id: string) {
  const riga = RIGHE.find((r) => r.id === id) ?? RIGHE[0]
  return {
    ...riga,
    email: 'candidata.finta@example.test',
    telefono: '+39 000 0000000',
    residence_city: 'Città di prova',
    residence_province: 'NA',
    titolo_studio: 'laurea_magistrale',
    anni_esperienza: 3,
    note: 'Presentazione di prova.',
    cv_path: null,
    sedi: [{ scuola_id: SEDE, stato: 'pending' }],
  }
}

async function serverFinto(page: Page) {
  await page.route('**/api/admin/candidature-insegnanti**', async (r) => {
    const url = new URL(r.request().url())
    if (url.pathname.endsWith('/etichetta')) {
      return r.fulfill({ json: { data: [], total: 0, colonnaAssente: false } })
    }
    const id = url.searchParams.get('id')
    if (id) return r.fulfill({ json: { data: dettaglioDi(id) } })
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return r.fulfill({
      json: { data: RIGHE.slice(offset, offset + limit), total: TOTALE, totaleLinguetta: TOTALE, limit, offset },
    })
  })
}

test('la voce «Candidature» sta nel menu e apre la pagina propria', async ({ page }) => {
  await serverFinto(page)
  await page.goto('/admin')
  await page.getByRole('link', { name: 'Candidature', exact: true }).first().click()
  await expect(page).toHaveURL(/\/admin\/candidature$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Candidature' })).toBeVisible()
})

test('il vecchio indirizzo di Modulistica porta alla pagina nuova, filtri compresi', async ({ page }) => {
  await serverFinto(page)
  await page.goto('/admin/modulistica?tab=candidature&posizione=cuoca')
  await expect(page).toHaveURL(/\/admin\/candidature\?.*posizione=cuoca/)
  await expect(page.getByRole('heading', { level: 1, name: 'Candidature' })).toBeVisible()
})

test('computer: aprendo una candidatura in fondo, il dettaglio è a schermo e la pagina non risale', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await serverFinto(page)
  await page.goto('/admin/candidature')
  const riga = page.getByText('Prova45 Candidata', { exact: true })
  await riga.scrollIntoViewIfNeeded()
  const primaDelClic = await page.evaluate(() => window.scrollY)
  expect(primaDelClic, 'la riga 45 doveva stare più in basso della prima schermata').toBeGreaterThan(400)

  await riga.click()
  const titolo = page.getByRole('heading', { level: 2, name: 'Prova45 Candidata' })
  await expect(titolo).toBeFocused()

  // La pagina è rimasta dov'era: niente salto in cima.
  const dopo = await page.evaluate(() => window.scrollY)
  expect(Math.abs(dopo - primaDelClic)).toBeLessThan(50)
  // E il titolo del dettaglio è DENTRO lo schermo, sotto la barra in alto.
  const box = await titolo.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(64)
  expect(box!.y + box!.height).toBeLessThanOrEqual(800)
})

test('telefono: il dettaglio si apre in un foglio, e chiudendolo la lista è dove l’avevo lasciata', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await serverFinto(page)
  await page.goto('/admin/candidature')
  const riga = page.getByText('Prova30 Candidata', { exact: true })
  await riga.scrollIntoViewIfNeeded()
  const primaDelClic = await page.evaluate(() => window.scrollY)
  expect(primaDelClic).toBeGreaterThan(400)

  await riga.click()
  const foglio = page.getByRole('dialog', { name: 'Candidature' })
  await expect(foglio).toBeVisible()
  await expect(foglio.getByRole('heading', { level: 2, name: 'Prova30 Candidata' })).toBeVisible()
  // A tutta larghezza: niente striscia di sfondo inutile su uno schermo già stretto.
  const pannello = await foglio.locator('.max-w-full').first().boundingBox()
  expect(pannello?.width).toBeGreaterThanOrEqual(370)

  await foglio.getByRole('button', { name: 'Chiudi' }).click()
  await expect(foglio).toBeHidden()
  const dopo = await page.evaluate(() => window.scrollY)
  expect(Math.abs(dopo - primaDelClic)).toBeLessThan(50)
  await expect(riga).toBeInViewport()
})
