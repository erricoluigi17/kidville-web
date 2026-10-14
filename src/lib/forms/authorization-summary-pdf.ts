import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { AUTHORIZATION_LABELS, type AuthorizationStatus } from './authorization-status'

export interface AuthorizationSummaryRow extends AuthorizationStatus {
  student_id: string
  nome_alunno: string
  cognome_alunno: string
}
export interface AuthorizationSummaryPayload {
  form: { title: string; description?: string | null; fields?: unknown[] }
  class_name: string
  results: AuthorizationSummaryRow[]
  generated_at: string
}
function printable(value: string): string {
  const text = value.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
  if (/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2022\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/u.test(text)) throw new Error('Carattere non supportato dal PDF')
  return text
}
function italianInstant(value: string): string {
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(new Date(value))
}
/** Stampa interna: A4 senza carta intestata, con testo misurato e intestazioni ripetute. */
export function buildAuthorizationSummaryPdf(payload: AuthorizationSummaryPayload): Uint8Array {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  pdf.setProperties({ title: printable(payload.form.title), author: 'Kidville', subject: 'Riepilogo interno autorizzazioni' })
  let y = 24
  const write = (value: string, size = 10, bold = false, gap = 3) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size)
    const lines = pdf.splitTextToSize(printable(value), 180) as string[]
    const step = size * 0.48
    for (const line of lines) {
      if (y + step > 277) { pdf.addPage(); y = 24 }
      pdf.text(line, 15, y); y += step
    }
    y += gap
  }
  write('RIEPILOGO AUTORIZZAZIONI', 14, true, 5)
  write(`Classe: ${payload.class_name}`, 11, true)
  write(payload.form.title, 12, true)
  if (payload.form.description) write(payload.form.description)
  write(`Stampa: ${italianInstant(payload.generated_at)} (ora italiana)`, 9)
  const authorized = payload.results.filter((r) => r.autorizzato).length
  write(`Totale: ${payload.results.length} | Autorizzati: ${authorized} | Altri esiti: ${payload.results.length - authorized}`, 10, true)
  const states = Object.keys(AUTHORIZATION_LABELS) as Array<keyof typeof AUTHORIZATION_LABELS>
  const counts = states.map((state) => `${AUTHORIZATION_LABELS[state]}: ${payload.results.filter((r) => r.stato_autorizzazione === state).length}`)
  write(counts.join(' | '), 9)
  write('Legenda: Autorizzato = firma valida e consensi obbligatori accettati, oppure cartaceo acquisito e validato dallo staff. Risposta ricevuta = sondaggio/gradimento compilato. Gli altri esiti richiedono compilazione, consenso o verifica della firma.', 9)
  if (y + 22 > 277) { pdf.addPage(); y = 24 }
  const rows = [...payload.results].sort((a, b) => a.cognome_alunno.localeCompare(b.cognome_alunno, 'it-IT') || a.nome_alunno.localeCompare(b.nome_alunno, 'it-IT'))
  autoTable(pdf, {
    startY: y, margin: { top: 24, left: 15, right: 15, bottom: 20 },
    head: [['Alunno', 'Esito', 'Metodo', 'Data firma']],
    body: rows.map((r) => [printable(`${r.cognome_alunno} ${r.nome_alunno}`), AUTHORIZATION_LABELS[r.stato_autorizzazione], r.metodo ?? '-', r.signed_at ? italianInstant(r.signed_at) : '-']),
    theme: 'grid', showHead: 'everyPage', rowPageBreak: 'avoid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 3, overflow: 'linebreak', lineColor: [215, 220, 216], lineWidth: 0.15, textColor: [32, 45, 38] },
    headStyles: { fillColor: [30, 72, 49], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 58 }, 2: { cellWidth: 32 }, 3: { cellWidth: 30 } },
  })
  const pages = pdf.getNumberOfPages()
  for (let n = 1; n <= pages; n++) {
    pdf.setPage(n); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(70, 80, 74)
    pdf.text('Kidville - Riepilogo interno', 15, 13)
    pdf.text(`Pagina ${n}/${pages}`, 195, 287, { align: 'right' })
  }
  return new Uint8Array(pdf.output('arraybuffer'))
}
