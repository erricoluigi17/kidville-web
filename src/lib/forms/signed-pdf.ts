import { jsPDF } from 'jspdf'
import { PDFDocument } from 'pdf-lib'
import { applicaCartaIntestata } from '@/lib/carta'
import { CARTA } from '@/lib/carta/geometria'
import type { SignedDocumentSnapshotV1 } from './signed-document'

export interface SignedPdfPayload {
  submissionId: string
  snapshot: SignedDocumentSnapshotV1
  signatureLog: Record<string, unknown>
  contentHash: string
}
export function formatSignedInstant(value: string): string {
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Rome' }).format(new Date(value))
}
/** Helvetica ha WinAnsi: nessun testo significativo può essere eliminato in silenzio. */
function printable(value: string): string {
  const normalized = value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
  // Repertorio Unicode della codifica Windows-1252, inclusi euro e legature.
  if (/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2022\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/u.test(normalized)) throw new Error('Carattere non supportato dal PDF: contenuto non archiviato')
  return normalized
}
function answerText(value: unknown, options: SignedDocumentSnapshotV1['form']['fields'][number]['options']): string {
  if (typeof value === 'boolean') return value ? 'Sì' : 'No'
  if (value === null || value === undefined || value === '') return 'Non compilato'
  if (Array.isArray(value)) return value.map((v) => answerText(v, options)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return options.find((o) => o.value === String(value))?.label ?? String(value)
}
/** Motore puro: tutte le righe rispettano l'area utile, comprese quelle del titolo. */
export function buildSignedPdfContent(payload: SignedPdfPayload): Uint8Array {
  const { snapshot } = payload
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  pdf.setProperties({ title: printable(snapshot.form.title), subject: 'Modulo sottoscritto', author: 'Kidville' })
  let y: number = CARTA.contenutoInizio
  const width = CARTA.margineDx - CARTA.margineSx
  const write = (value: string, size = 10, bold = false, gap = 3) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    const lines = pdf.splitTextToSize(printable(value), width) as string[]
    const step = size * 0.48
    for (const line of lines) {
      if (y + 1 > CARTA.contenutoFine) { pdf.addPage(); y = CARTA.contenutoInizio }
      pdf.text(line, CARTA.margineSx, y)
      y += step
    }
    y += gap
  }
  write(snapshot.form.title, 15, true, 5)
  if (snapshot.source === 'reconstructed') write(`Documento ricostruito il ${formatSignedInstant(snapshot.reconstructed_at!)} dalle risposte e dalla firma registrate il ${formatSignedInstant(snapshot.signed_at)}; testo del modello attualmente disponibile.`, 9, false, 5)
  if (snapshot.form.description) write(snapshot.form.description)
  write(`Bambino: ${snapshot.student ? `${snapshot.student.nome} ${snapshot.student.cognome}` : 'Compilazione prima dell’iscrizione'}`)
  write(`Firmatario: ${snapshot.signer.nome} ${snapshot.signer.cognome}`)
  for (const field of snapshot.form.fields) {
    if (field.type === 'signature') continue
    if (field.type === 'section_header') { write(field.label, 11, true); continue }
    if (field.type === 'paragraph') { write(field.text || field.label); continue }
    if (field.text) write(field.text)
    if (field.link) write(`${field.link_label || 'Informativa'}: ${field.link}`, 9)
    write(`${field.label}: ${answerText(snapshot.answers[field.id], field.options)}`)
  }
  write(`Metodo: ${payload.signatureLog.method === 'OTP_EMAIL' ? 'Firma elettronica semplice (FES) tramite OTP email' : 'Firma elettronica semplice (FES) con conferma in app'}`, 10, true)
  write(`Firma registrata il: ${formatSignedInstant(snapshot.signed_at)} (ora italiana)`)
  write(`ID compilazione: ${payload.submissionId}`, 9)
  write(`Hash documento: ${payload.contentHash}`, 9)
  const pages = pdf.getNumberOfPages()
  for (let n = 1; n <= pages; n++) {
    pdf.setPage(n); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7)
    pdf.text(`Pagina ${n}/${pages}`, CARTA.margineDx, CARTA.rigaServizio, { align: 'right' })
  }
  return new Uint8Array(pdf.output('arraybuffer'))
}
export async function buildSignedPdfSuCarta(payload: SignedPdfPayload): Promise<Uint8Array> {
  const composed = await applicaCartaIntestata(buildSignedPdfContent(payload))
  const document = await PDFDocument.load(composed)
  document.setSubject(`kidville-signed-document:${payload.contentHash}`)
  document.setTitle(printable(payload.snapshot.form.title))
  return document.save()
}
