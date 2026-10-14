import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { getDocumentProxy } from 'unpdf'
import { clienteDatabaseCi } from './helpers/database-ci'
import { IDS, STORAGE, EMAILS, login } from './fixtures'

// Scritture solo sul progetto CI: clienteDatabaseCi rifiuta CI assente e URL diverso.
// L'OTP proviene da next dev :3100. Nessun codice di debug sul server compilato.
test.describe.configure({ retries: 0 })
test.use({ storageState: STORAGE.genitore, trace: 'off', video: 'off', screenshot: 'off' })
const BASE = 'http://localhost:3100'
// Come isolamento-sedi: next dev compila le pagine fredde e il bootstrap
// genitore carica cinque API in sequenza. Il limite riguarda la readiness,
// mentre titolo/download conservano le asserzioni strette e lo spec non ha retry.
const READINESS_MS = 60_000
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function testoPdf(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(bytes.slice())
  {
    const chunks: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      chunks.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '))
    }
    return chunks.join(' ').replace(/\s+/g, ' ')
  }
}
async function verificaContestoVuoto(context: BrowserContext) {
  // Playwright eredita test.use anche nei newContext manuali. Controlliamo
  // soltanto conteggi: cookie, localStorage e token non entrano negli artifact.
  const state = await context.storageState()
  expect(state.cookies.length, 'nuovo contesto senza cookie ereditati').toBe(0)
  expect(state.origins.length, 'nuovo contesto senza origini ereditate').toBe(0)
}
async function negato(api: APIRequestContext, id: string, status: number, headers: Record<string, string> = {}) {
  for (const method of ['get', 'post'] as const) {
    const response = method === 'get'
      ? await api.get(`${BASE}/api/forms/signed-pdf?id=${id}`, { headers })
      : await api.post(`${BASE}/api/forms/signed-pdf`, { data: { id }, headers })
    expect(response.status(), `accesso ${method} fuori scope`).toBe(status)
    expect(response.headers()['cache-control']).toContain('no-store')
    expect(response.headers()['content-type']).not.toContain('application/pdf')
  }
}
function controlloDb(error: unknown, operazione: string) {
  if (error) {
    const code = typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'ERRORE_DB'
    throw new Error(`${operazione}: ${code} (nessun corpo o dato personale stampato)`)
  }
}

test('firma OTP, archivio reale e riepilogo isolato per sede', async ({ page, browser }) => {
  // Bootstrap archivio più due login fuori scope (stesso budget degli spec sede).
  test.setTimeout(180_000)
  const db = clienteDatabaseCi() // prima di qualsiasi lettura/scrittura
  const formId = randomUUID()
  const title = `Autorizzazione museo CI ${formId.slice(0, 8)}`
  const description = 'Autorizzo la visita al museo di prova. Il documento conserva il testo completo.'
  const answer = 'Preferenza percorso educativo di prova'
  let submissionId: string | null = null
  let ownedPdfPath: string | null = null
  const extraContexts: BrowserContext[] = []
  try {
    controlloDb((await db.from('forms_templates').insert({
      id: formId, scuola_id: IDS.SCUOLA, title, description,
      form_type: 'autorizzazione', target_scope: 'class', target_classes: ['Girasoli'],
      fields: [
        { id: 'consenso', type: 'checkbox', label: 'Autorizzo la visita', required: true },
        { id: 'nota', type: 'textarea', label: 'Preferenza', required: false },
      ],
    })).error, 'Crea modello fittizio')
    // Il ticket e il codice restano in memoria: trace/screenshot/video disattivati per lo spec.
    const otpResponse = await page.request.post('/api/parent/forms/otp', { data: {} })
    expect(otpResponse.status()).toBe(200)
    const otp = await otpResponse.json() as { ticket?: string; expiry?: number; devCode?: string }
    expect(typeof otp.ticket, 'ticket emesso dal server dev').toBe('string')
    expect(typeof otp.devCode, 'il server CI :3100 deve essere next dev').toBe('string')
    const signed = await page.request.patch('/api/parent/forms/otp', { data: {
      code: otp.devCode, ticket: otp.ticket, expiry: otp.expiry,
      form_id: formId, student_id: IDS.A1, answers: { consenso: true, nota: answer },
    } })
    expect(signed.status(), 'firma reale accettata').toBe(201)
    const result = await signed.json() as { pdf_ready?: boolean; submission?: { id: string; pdf_path: string; signature_log: { document_hash: string; document_snapshot: { school_id: string } } } }
    expect(result.pdf_ready, 'PDF effettivamente archiviato').toBe(true)
    const submission = result.submission!
    submissionId = submission.id
    ownedPdfPath = `signed_forms/${IDS.SCUOLA}/${submissionId}.pdf`
    expect(submission.pdf_path).toBe(ownedPdfPath)
    expect(submission.signature_log.document_snapshot.school_id).toBe(IDS.SCUOLA)

    const stored = await db.storage.from('form_attachments').download(ownedPdfPath)
    controlloDb(stored.error, 'Legge PDF archiviato')
    expect(stored.data !== null, 'oggetto Storage presente').toBe(true)
    const storedBytes = new Uint8Array(await stored.data!.arrayBuffer())
    expect(new TextDecoder().decode(storedBytes.subarray(0, 5))).toBe('%PDF-')
    const pdf = await PDFDocument.load(storedBytes)
    expect(pdf.getSubject()).toBe(`kidville-signed-document:${submission.signature_log.document_hash}`)
    const fullText = await testoPdf(storedBytes)
    expect(fullText).toContain(title)
    expect(fullText).toContain(description)
    expect(fullText).toContain(answer)
    expect(fullText).toContain('Autorizzo la visita')
    expect(fullText).not.toContain(EMAILS.genitore)

    const privatePdf = await page.request.get(`/api/forms/signed-pdf?id=${submissionId}`)
    expect(privatePdf.status()).toBe(200)
    expect(privatePdf.headers()['cache-control']).toContain('no-store')
    expect(sha256(await privatePdf.body())).toBe(sha256(storedBytes))
    const prepare = await page.request.post('/api/forms/signed-pdf', { data: { id: submissionId } })
    expect(prepare.status()).toBe(200)
    const repeated = await page.request.get(`/api/forms/signed-pdf?id=${submissionId}`)
    expect(sha256(await repeated.body())).toBe(sha256(storedBytes))

    // Registrate prima di goto: attendiamo i dati della pagina, non solo il
    // guscio SSR. Status/campi essenziali espliciti impediscono falsi verdi
    // in caso di API fallita o di arricchimento titolo/figlio mancante.
    const archiveLoaded = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/parent/submissions' && response.request().method() === 'GET',
    { timeout: READINESS_MS })
    const childrenLoaded = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/parent/students' && response.request().method() === 'GET',
    { timeout: READINESS_MS })
    const [archiveResponse, childrenResponse] = await Promise.all([
      archiveLoaded, childrenLoaded, page.goto(`/parent/modulistica?tab=archivio&id=${IDS.A1}`),
    ])
    expect(archiveResponse.status(), 'archivio caricato dalla pagina').toBe(200)
    const archiveRows = await archiveResponse.json() as Array<{ id: string; form_id: string; student_id: string; forms_templates: { title: string } | null }>
    expect(Array.isArray(archiveRows), 'archivio restituito come elenco').toBe(true)
    const ownedArchiveRow = archiveRows.find((row) => row.id === submissionId)
    // Nessuna asserzione sull'intero payload: signature_log e OTP restano in memoria.
    expect(ownedArchiveRow !== undefined, 'compilazione firmata presente nell’archivio').toBe(true)
    expect(ownedArchiveRow?.form_id).toBe(formId)
    expect(ownedArchiveRow?.student_id).toBe(IDS.A1)
    expect(ownedArchiveRow?.forms_templates?.title).toBe(title)
    expect(childrenResponse.status(), 'figli riletti dal server').toBe(200)
    const children = await childrenResponse.json() as { data: Array<{ id: string }> }
    expect(Array.isArray(children.data), 'elenco figli autorevole').toBe(true)
    expect(children.data.some((child) => child.id === IDS.A1), 'bambino della compilazione raggiungibile dal genitore').toBe(true)
    await expect(page.locator('main#content').getByText('Caricamento in corso…', { exact: true })).toBeHidden({ timeout: READINESS_MS })
    const heading = page.getByRole('heading', { name: title, exact: true })
    await expect(heading).toBeVisible()
    const card = heading.locator('..').locator('..')
    const downloading = page.waitForEvent('download')
    await card.getByRole('button', { name: 'Scarica autorizzazione firmata', exact: true }).click()
    const download = await downloading
    expect(await download.failure()).toBeNull()
    const stream = await download.createReadStream()
    expect(stream !== null).toBe(true)
    const chunks: Buffer[] = []
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(storedBytes))

    const admin = await browser.newContext({ storageState: STORAGE.admin, baseURL: BASE })
    extraContexts.push(admin)
    const query = `/api/admin/documents-merge?form_id=${formId}&class_name=Girasoli`
    const summaryResponse = await admin.request.get(query)
    expect(summaryResponse.status()).toBe(200)
    const summary = await summaryResponse.json() as { form: { id: string }; results: Array<{ student_id: string; autorizzato: boolean; signed: boolean }> }
    expect(summary.form.id).toBe(formId)
    expect(summary.results.find((r) => r.student_id === IDS.A1)).toMatchObject({ autorizzato: true, signed: true })
    expect(summary.results.some((r) => r.student_id === IDS.B1)).toBe(false) // Girasoli omonima in sede 2
    const reportResponse = await admin.request.get(`${query}&format=pdf`)
    expect(reportResponse.status()).toBe(200)
    expect(reportResponse.headers()['content-type']).toContain('application/pdf')
    const reportText = await testoPdf(new Uint8Array(await reportResponse.body()))
    expect(reportText).toContain(title)
    expect(reportText).toContain('Autorizzato')
    expect(reportText).not.toContain('Eclissi') // cognome fittizio del bambino nell'altra Girasoli
    expect(reportText).not.toContain('User-Agent')
    const adminPdf = await admin.request.get(`/api/forms/signed-pdf?id=${submissionId}`)
    expect(adminPdf.status()).toBe(200)
    expect(sha256(await adminPdf.body())).toBe(sha256(storedBytes))

    const anonymous = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } })
    extraContexts.push(anonymous)
    await verificaContestoVuoto(anonymous)
    const forged = { 'x-user-id': IDS.GENITORE, 'x-user-role': 'admin', 'x-school-id': IDS.SCUOLA }
    await negato(anonymous.request, submissionId, 401)
    await negato(anonymous.request, submissionId, 401, forged)
    for (const [email, status] of [[EMAILS.genitore2, 403], [EMAILS.segreteria2, 404]] as const) {
      const foreign = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } })
      extraContexts.push(foreign)
      await verificaContestoVuoto(foreign)
      const foreignPage = await foreign.newPage()
      await login(foreignPage, email)
      const area = email === EMAILS.genitore2 ? '/parent' : '/admin'
      await foreignPage.waitForURL((url) => url.pathname === area || url.pathname.startsWith(`${area}/`), { timeout: READINESS_MS })
      await negato(foreign.request, submissionId, status)
      await negato(foreign.request, submissionId, status, forged)
      const refusedReport = await foreign.request.get(query, { headers: forged })
      expect(refusedReport.status()).toBe(email === EMAILS.genitore2 ? 403 : 404)
    }
  } finally {
    // Solo i nostri oggetti e righe. Anche un errore prima di ricevere l'id recupera il proprio PDF.
    const ownedRows = await db.from('forms_submissions').select('id, pdf_path').eq('form_id', formId)
    controlloDb(ownedRows.error, 'Inventario pulizia proprio modulo')
    const paths = new Set<string>()
    if (ownedPdfPath) paths.add(ownedPdfPath)
    for (const row of ownedRows.data ?? []) {
      paths.add(`signed_forms/${IDS.SCUOLA}/${row.id}.pdf`)
      if (row.pdf_path === `signed_forms/${IDS.SCUOLA}/${row.id}.pdf`) paths.add(row.pdf_path)
    }
    if (paths.size) controlloDb((await db.storage.from('form_attachments').remove([...paths])).error, 'Pulizia propri PDF')
    controlloDb((await db.from('forms_submissions').delete().eq('form_id', formId)).error, 'Pulizia proprie compilazioni')
    controlloDb((await db.from('forms_templates').delete().eq('id', formId)).error, 'Pulizia proprio modello')
    for (const context of extraContexts) await context.close()
  }
})
