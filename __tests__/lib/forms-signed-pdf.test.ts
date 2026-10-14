// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getDocumentProxy } from 'unpdf'
import { PDFDocument } from 'pdf-lib'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { elementiTesto } from '../fixtures/misure-pdf'
import { SUBMISSION, ORIGINAL_SIGNATURE, signedFormsDb } from '../fixtures/signed-forms'

async function payload(long = false, historical = false) {
  const pending = import('@/lib/forms/signed-document')
  await expect(pending).resolves.toBeDefined()
  const { buildSignedDocumentSnapshot, freezeSignedDocument } = await pending
  const db = signedFormsDb()
  if (long) db.forms_templates[0].description = Array.from({ length: 130 }, (_, i) => `Riga autorizzazione numero ${i + 1}: testo integrale lungo.`).join('\n')
  const snapshot = buildSignedDocumentSnapshot({ template: db.forms_templates[0], student: db.alunni[0], signer: db.utenti[0], answers: db.forms_submissions[0].answers, signatureLog: ORIGINAL_SIGNATURE, source: historical ? 'reconstructed' : 'contemporaneous', reconstructedAt: historical ? '2026-10-14T08:00:00.000Z' : undefined })
  const signature = freezeSignedDocument(ORIGINAL_SIGNATURE, snapshot)
  return { submissionId: SUBMISSION, snapshot, signatureLog: signature, contentHash: signature.document_hash }
}
async function text(bytes: Uint8Array) {
  const doc = await getDocumentProxy(bytes.slice())
  const chunks: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const items = await page.getTextContent()
    chunks.push(items.items.map((item) => 'str' in item ? item.str : '').join(' '))
  }
  return chunks.join(' ').replace(/\s+/g, ' ')
}
describe('PDF completo firmato', () => {
  it('stampa testo, etichette, risposte Si/No, nominativi e data originale Europe/Rome', async () => {
    const pending = import('@/lib/forms/signed-pdf'); await expect(pending).resolves.toBeDefined()
    const { buildSignedPdfContent } = await pending
    const p = await payload()
    const bytes = buildSignedPdfContent(p)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const out = await text(bytes)
    for (const phrase of ['Autorizzazione uscita', 'Autorizzo la visita al museo.', 'Bambino Esempio', 'Genitore Esempio', 'Autorizzo la visita: Sì', 'Utilizza autobus: No', 'Scelta: Prima opzione', 'Risposta presente', '05/08/2026', '11:00', 'Firma elettronica semplice', SUBMISSION, p.contentHash]) expect(out).toContain(phrase)
    for (const secret of [ORIGINAL_SIGNATURE.email, ORIGINAL_SIGNATURE.hash, ORIGINAL_SIGNATURE.ip, ORIGINAL_SIGNATURE.user_agent]) expect(out).not.toContain(secret)
  })
  it('testi lunghi vanno a capo senza uscire dalla carta e con pagina n/m su ogni foglio', async () => {
    const { buildSignedPdfContent } = await import('@/lib/forms/signed-pdf')
    const bytes = buildSignedPdfContent(await payload(true))
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThan(2)
    const out = await text(bytes)
    expect(out).toContain('Riga autorizzazione numero 130')
    for (let n = 1; n <= doc.getPageCount(); n++) expect(out).toContain(`Pagina ${n}/${doc.getPageCount()}`)
    const elements = await elementiTesto(bytes)
    const body = elements.filter((e) => !e.testo.startsWith('Pagina '))
    expect(body.every((e) => e.xMm >= CARTA.margineSx - 0.2 && e.xMm + e.larghezzaMm <= CARTA.margineDx + 0.2 && ingombroTesto(e.yMm, e.corpoPt).fondo <= CARTA.contenutoFine + 0.2)).toBe(true)
    for (let i = 1; i < body.length; i++) {
      const before = body[i - 1], next = body[i]
      if (before.pagina === next.pagina) expect(ingombroTesto(before.yMm, before.corpoPt).fondo).toBeLessThan(ingombroTesto(next.yMm, next.corpoPt).cima)
    }
  })
  it('ricostruzione chiaramente distinta da data firma', async () => {
    const { buildSignedPdfContent } = await import('@/lib/forms/signed-pdf')
    const out = await text(buildSignedPdfContent(await payload(false, true)))
    expect(out).toContain('Documento ricostruito il')
    expect(out).toContain('14/10/2026')
    expect(out).toContain('dalle risposte e dalla firma registrate il')
    expect(out).toContain('testo del modello attualmente disponibile')
  })
  it('consegna sulla carta reale preservando il testo', async () => {
    const { buildSignedPdfSuCarta } = await import('@/lib/forms/signed-pdf')
    const bytes = await buildSignedPdfSuCarta(await payload())
    expect(bytes.length).toBeGreaterThan(20000)
    expect(await text(bytes)).toContain('Autorizzo la visita al museo.')
  })
  it('non cancella euro e caratteri rappresentabili WinAnsi', async () => {
    const { buildSignedPdfContent } = await import('@/lib/forms/signed-pdf')
    const p = await payload(); p.snapshot.form.description = 'Quota € 10,00; l’attività…'
    const out = await text(buildSignedPdfContent(p))
    expect(out).toContain('Quota € 10,00')
    expect(out).toContain("l'attività...")
  })
  it('un glifo non rappresentabile causa errore esplicito senza consegnare testo mutilato', async () => {
    const { buildSignedPdfContent } = await import('@/lib/forms/signed-pdf')
    const p = await payload(); p.snapshot.form.description = 'Testo significativo 漢'
    expect(() => buildSignedPdfContent(p)).toThrow('Carattere non supportato')
  })
})
