import path from 'node:path'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { PDFDocument, StandardFonts, rgb, type RGB } from 'pdf-lib'

/**
 * Il test attraversa la pagina vera dei pagamenti e i componenti
 * FatturaDocumenti -> FatturaViewer. Le sole risposte intercettate sono i dati
 * deterministici del caso: il browser carica il chunk PDF.js reale e disegna i
 * PDF veri sul canvas. Il seed e il database non vengono toccati.
 *
 * Gira senza retry: un render fallito non deve sparire dietro un secondo giro.
 */
test.describe.configure({ retries: 0, timeout: 60_000 })
test.use({
  storageState: path.join(process.cwd(), 'e2e', '.auth', 'genitore.json'),
  serviceWorkers: 'block',
})

const GENITORE = 'e2e00000-0000-4000-8000-000000000203'
const ALUNNA = 'e2e0fd00-0000-4000-8000-000000000101'
const PAGAMENTO = 'e2e0fd00-0000-4000-8000-000000000001'
const FATTURA_A = 'e2e0fd00-0000-4000-8000-000000000011'
const FATTURA_B = 'e2e0fd00-0000-4000-8000-000000000012'

interface PaginaSintetica {
  testo: string
  sfondo: RGB
}

async function creaPdf(pagine: PaginaSintetica[]): Promise<Buffer> {
  const documento = await PDFDocument.create()
  const font = await documento.embedFont(StandardFonts.HelveticaBold)

  for (const contenuto of pagine) {
    const pagina = documento.addPage([480, 640])
    pagina.drawRectangle({
      x: 0,
      y: 0,
      width: pagina.getWidth(),
      height: pagina.getHeight(),
      color: contenuto.sfondo,
    })
    pagina.drawText(contenuto.testo, {
      x: 36,
      y: 540,
      size: 24,
      font,
      color: rgb(1, 1, 1),
    })
  }

  return Buffer.from(await documento.save())
}

async function pixelInterno(canvas: Locator): Promise<[number, number, number, number]> {
  return canvas.evaluate((elemento) => {
    const c = elemento as HTMLCanvasElement
    const contesto = c.getContext('2d')
    if (!contesto) throw new Error('canvas-senza-contesto-2d')
    const x = Math.max(0, Math.floor(c.width * 0.8))
    const y = Math.max(0, Math.floor(c.height * 0.8))
    return [...contesto.getImageData(x, y, 1, 1).data] as [number, number, number, number]
  })
}

async function installaRisposte(
  page: Page,
  pdfA: Buffer,
  pdfB: Buffer,
  pdfRichiesti: string[],
  esiti: Array<{ fattura_id?: string; esito?: string }>,
  apiImpreviste: string[],
): Promise<void> {
  await page.routeWebSocket('**/realtime/v1/**', (socket) => socket.close())

  await page.route('**/api/**', async (route: Route) => {
    const richiesta = route.request()
    const url = new URL(richiesta.url())

    // La shell parent monta questi lettori insieme alla pagina. Risposte
    // coerenti evitano sia chiamate al backend sia un falso test del solo corpo
    // pagina con AppBar/ChildSwitcher in errore.
    if (url.pathname === '/api/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: GENITORE,
          role: 'genitore',
          ruolo: 'genitore',
          profili: [{ ruolo: 'genitore', area: 'parent' }],
        }),
      })
      return
    }

    if (url.pathname === '/api/parent/students') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{
            id: ALUNNA,
            nome: 'Alunna',
            cognome: 'Collaudo',
            classe_sezione: 'E2E',
            scuola_id: 'e2e00000-0000-4000-8000-000000000001',
            scuola_nome: 'Kidville E2E',
          }],
          in_attesa: false,
        }),
      })
      return
    }

    if (url.pathname === '/api/parent/primaria') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { schoolType: 'infanzia' } }),
      })
      return
    }

    if (url.pathname === '/api/notifiche') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], non_lette: 0 }),
      })
      return
    }

    if (url.pathname === '/api/pagamenti/sospensione-stato') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { sospeso: false, totaleScaduto: 0 } }),
      })
      return
    }

    if (url.pathname === '/api/pagamenti') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{
            id: PAGAMENTO,
            alunno_id: ALUNNA,
            scuola_id: 'e2e00000-0000-4000-8000-000000000001',
            descrizione: 'Pagamento con fatture proprie E2E',
            importo: 220,
            importo_pagato: 220,
            scadenza: '2026-09-15',
            stato: 'pagato',
            tipo: 'singolo',
            obbligatorio: true,
            payment_categories: { nome: 'Rette', icona: '🧾' },
            alunni: { nome: 'Alunna', cognome: 'Collaudo', sospeso: false },
          }],
          sedi: [],
        }),
      })
      return
    }

    if (url.pathname === '/api/pagamenti/fattura/list') {
      expect(url.searchParams.get('pagamento_id')).toBe(PAGAMENTO)
      expect(url.searchParams.get('userId')).toBe(GENITORE)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: FATTURA_A,
              numero: 701,
              anno: 2026,
              quota_label: 'Quota propria A',
              intestatario: 'Intestatario A',
              pdf_disponibile: true,
            },
            {
              id: FATTURA_B,
              numero: 702,
              anno: 2026,
              quota_label: 'Quota propria B',
              intestatario: 'Intestatario B',
              pdf_disponibile: true,
            },
            // Il documento aggregato scartato e senza PDF non deve togliere le
            // due fatture proprie e non deve produrre un terzo comando.
            {
              id: 'e2e0fd00-0000-4000-8000-000000000099',
              numero: 799,
              anno: 2026,
              quota_label: 'Aggregato scartato',
              intestatario: 'Aggregato',
              pdf_disponibile: false,
              sdi_stato_label: 'Scartata dallo SDI',
            },
          ],
        }),
      })
      return
    }

    if (url.pathname === '/api/pagamenti/fattura/esito') {
      esiti.push((richiesta.postDataJSON() ?? {}) as { fattura_id?: string; esito?: string })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
      return
    }

    if (url.pathname === '/api/pagamenti/fattura') {
      const fatturaId = url.searchParams.get('fattura_id') ?? ''
      expect(url.searchParams.get('pagamento_id')).toBe(PAGAMENTO)
      expect(url.searchParams.get('userId')).toBe(GENITORE)
      expect([FATTURA_A, FATTURA_B]).toContain(fatturaId)
      pdfRichiesti.push(fatturaId)
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'cache-control': 'no-store',
          'content-disposition': 'inline',
        },
        body: fatturaId === FATTURA_A ? pdfA : pdfB,
      })
      return
    }

    // Nessuna API applicativa fuori dal caso deve arrivare al backend: in
    // locale `.env.local` puo' puntare alla produzione. Si conserva il metodo e
    // il solo pathname (nessun dato personale della query) per la diagnosi.
    apiImpreviste.push(`${richiesta.method()} ${url.pathname}`)
    await route.abort('blockedbyclient')
  })
}

test('renderizza, naviga, ingrandisce e cambia due fatture reali senza errori asincroni', async ({ page }) => {
  const pdfA = await creaPdf([
    { testo: 'FATTURA-A PAGINA-1', sfondo: rgb(0.82, 0.12, 0.08) },
    { testo: 'FATTURA-A PAGINA-2', sfondo: rgb(0.08, 0.64, 0.18) },
  ])
  const pdfB = await creaPdf([
    { testo: 'FATTURA-B PAGINA-1', sfondo: rgb(0.08, 0.22, 0.82) },
    { testo: 'FATTURA-B PAGINA-2', sfondo: rgb(0.58, 0.12, 0.72) },
  ])
  const erroriPagina: string[] = []
  const pdfRichiesti: string[] = []
  const esiti: Array<{ fattura_id?: string; esito?: string }> = []
  const apiImpreviste: string[] = []

  page.on('pageerror', (errore) => erroriPagina.push(`${errore.name}: ${errore.message}`))
  await page.addInitScript(() => {
    const finestra = window as typeof window & { __rifiutiNonGestiti?: string[] }
    finestra.__rifiutiNonGestiti = []
    window.addEventListener('unhandledrejection', (evento) => {
      const causa = evento.reason
      finestra.__rifiutiNonGestiti!.push(
        causa instanceof Error ? `${causa.name}: ${causa.message}` : String(causa),
      )
    })
  })
  await installaRisposte(page, pdfA, pdfB, pdfRichiesti, esiti, apiImpreviste)

  await page.goto('/parent/pagamenti')
  await expect(page.getByRole('heading', { name: 'Pagamenti' })).toBeVisible()
  await expect(page.getByText('Pagamento con fatture proprie E2E')).toBeVisible()
  await expect(page.getByText('Fattura — Quota propria A')).toBeVisible()
  await expect(page.getByText('Fattura — Quota propria B')).toBeVisible()
  await expect(page.getByText('Aggregato scartato')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Apri' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Apri' }).nth(0).click()
  let dialogo = page.getByRole('dialog', { name: 'Fattura' })
  await expect(dialogo).toBeVisible()
  await expect(dialogo.getByLabel('Testo della pagina 1')).toContainText('FATTURA-A PAGINA-1')
  await expect(dialogo.getByText('Pagina 1 di 2')).toBeVisible()

  let canvas = dialogo.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect.poll(async () => {
    const [rosso, verde, blu, alfa] = await pixelInterno(canvas)
    return alfa === 255 && rosso > verde + 80 && rosso > blu + 80
  }).toBe(true)

  await dialogo.getByRole('button', { name: 'Pagina successiva' }).click()
  await expect(dialogo.getByLabel('Testo della pagina 2')).toContainText('FATTURA-A PAGINA-2')
  await expect(dialogo.getByText('Pagina 2 di 2')).toBeVisible()
  await expect.poll(async () => {
    const [rosso, verde, blu, alfa] = await pixelInterno(canvas)
    return alfa === 255 && verde > rosso + 80 && verde > blu + 50
  }).toBe(true)

  const larghezzaPrima = await canvas.evaluate((elemento) =>
    (elemento as HTMLCanvasElement).getBoundingClientRect().width,
  )
  await dialogo.getByRole('button', { name: 'Aumenta zoom' }).click()
  await expect(dialogo.getByText('125%')).toBeVisible()
  await expect(dialogo.getByLabel('Testo della pagina 2')).toContainText('FATTURA-A PAGINA-2')
  await expect.poll(async () => canvas.evaluate((elemento) =>
    (elemento as HTMLCanvasElement).getBoundingClientRect().width,
  )).toBeGreaterThan(larghezzaPrima * 1.2)

  await dialogo.getByRole('button', { name: 'Chiudi anteprima fattura' }).click()
  await expect(dialogo).toHaveCount(0)

  // La riapertura deve ripartire dalla prima pagina e dallo zoom iniziale.
  await page.getByRole('button', { name: 'Apri' }).nth(0).click()
  dialogo = page.getByRole('dialog', { name: 'Fattura' })
  await expect(dialogo.getByLabel('Testo della pagina 1')).toContainText('FATTURA-A PAGINA-1')
  await expect(dialogo.getByText('Pagina 1 di 2')).toBeVisible()
  await expect(dialogo.getByText('100%')).toBeVisible()
  await dialogo.getByRole('button', { name: 'Chiudi anteprima fattura' }).click()
  await expect(dialogo).toHaveCount(0)

  // Il secondo comando deve caricare il secondo PDF, non riusare il documento A.
  await page.getByRole('button', { name: 'Apri' }).nth(1).click()
  dialogo = page.getByRole('dialog', { name: 'Fattura' })
  await expect(dialogo.getByLabel('Testo della pagina 1')).toContainText('FATTURA-B PAGINA-1')
  await expect(dialogo.getByText('Pagina 1 di 2')).toBeVisible()
  canvas = dialogo.locator('canvas')
  await expect.poll(async () => {
    const [rosso, verde, blu, alfa] = await pixelInterno(canvas)
    return alfa === 255 && blu > rosso + 80 && blu > verde + 80
  }).toBe(true)

  await dialogo.getByRole('button', { name: 'Pagina successiva' }).click()
  await expect(dialogo.getByLabel('Testo della pagina 2')).toContainText('FATTURA-B PAGINA-2')
  await expect(dialogo.getByText('Pagina 2 di 2')).toBeVisible()

  expect(pdfRichiesti).toEqual([FATTURA_A, FATTURA_A, FATTURA_B])
  await expect.poll(() => esiti.filter((e) => e.esito === 'visualizzata').length).toBe(3)
  expect(esiti.filter((e) => e.esito === 'visualizzata').map((e) => e.fattura_id)).toEqual([
    FATTURA_A,
    FATTURA_A,
    FATTURA_B,
  ])
  expect(erroriPagina).toEqual([])
  expect(apiImpreviste).toEqual([])
  expect(await page.evaluate(() =>
    (window as typeof window & { __rifiutiNonGestiti?: string[] }).__rifiutiNonGestiti ?? [],
  )).toEqual([])
})
