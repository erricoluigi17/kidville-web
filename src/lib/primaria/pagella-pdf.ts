import { jsPDF } from 'jspdf'

export interface PagellaData {
  scuolaNome: string
  classe: string
  anno: string
  periodo: string
  alunno: string
  discipline: { materia: string; giudizio: string; obiettivo?: string | null; descrittivo?: string | null }[]
  comportamento: string | null
  giudizioGlobale: string | null
  dirigente: string | null
  chiusoIl: string | null
}

/**
 * Costruisce la pagella (documento di valutazione) in PDF statico, conforme
 * O.M. 3/2025: giudizi sintetici per disciplina, comportamento e giudizio
 * globale. La "firma applicativa" è la riga di chiusura con nome dirigente +
 * data (no firma qualificata in questa fase). Riusa lo stile del PDF dei moduli
 * (src/app/api/forms/export/pdf/route.ts).
 */
export function buildPagellaPdf(d: PagellaData): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Header band
  doc.setFillColor(0, 106, 95) // kidville-green
  doc.rect(0, 0, 210, 42, 'F')
  doc.setFillColor(253, 196, 0) // kidville-yellow
  doc.rect(0, 0, 4, 42, 'F')

  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(255, 255, 255)
  doc.text(d.scuolaNome, 14, 17)

  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(220, 240, 235)
  doc.text('Documento di valutazione — Scuola Primaria', 14, 25)
  doc.setFontSize(8)
  doc.text(`Anno scolastico ${d.anno}  ·  ${d.periodo}`, 14, 32)

  // Student / class band
  let y = 54
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(20, 28, 40)
  doc.text(d.alunno || '—', 14, y)
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(100, 116, 139)
  doc.text(`Classe ${d.classe}`, 196, y, { align: 'right' })
  y += 6
  doc.setDrawColor(0, 106, 95)
  doc.setLineWidth(0.5)
  doc.line(14, y, 196, y)
  y += 10

  // Disciplines table
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(0, 106, 95)
  doc.text('DISCIPLINA', 14, y)
  doc.text('GIUDIZIO SINTETICO', 196, y, { align: 'right' })
  y += 3
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.2)
  doc.line(14, y, 196, y)
  y += 7

  for (const row of d.discipline) {
    if (y > 248) { doc.addPage(); y = 20 }
    doc.setFontSize(10.5)
    doc.setFont('Helvetica', 'normal')
    doc.setTextColor(30, 41, 59)
    doc.text(row.materia, 14, y)
    doc.setFont('Helvetica', 'bold')
    doc.setTextColor(0, 90, 80)
    doc.text(row.giudizio || '—', 196, y, { align: 'right' })
    y += 5
    // Obiettivo della classe (riga piccola sotto la disciplina).
    if (row.obiettivo) {
      doc.setFont('Helvetica', 'italic')
      doc.setFontSize(7.5)
      doc.setTextColor(120, 130, 145)
      const ob = doc.splitTextToSize(`Obiettivo: ${row.obiettivo}`, 150) as string[]
      doc.text(ob, 14, y)
      y += ob.length * 3.5
    }
    // Giudizio descrittivo associato al voto (auto da scala).
    if (row.descrittivo) {
      doc.setFont('Helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(100, 116, 139)
      const de = doc.splitTextToSize(row.descrittivo, 180) as string[]
      doc.text(de, 14, y)
      y += de.length * 3.5
    }
    y += 3
    doc.setDrawColor(241, 245, 249)
    doc.setLineWidth(0.15)
    doc.line(14, y - 2, 196, y - 2)
  }

  // Comportamento
  y += 8
  if (y > 240) { doc.addPage(); y = 20 }
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(0, 106, 95)
  doc.text('COMPORTAMENTO', 14, y)
  y += 6
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(10.5)
  doc.setTextColor(30, 41, 59)
  {
    const lines = doc.splitTextToSize(d.comportamento || '—', 182) as string[]
    doc.text(lines, 14, y)
    y += lines.length * 5 + 6
  }

  // Giudizio globale
  if (d.giudizioGlobale) {
    if (y > 235) { doc.addPage(); y = 20 }
    doc.setFont('Helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(0, 106, 95)
    doc.text('GIUDIZIO GLOBALE', 14, y)
    y += 6
    doc.setFont('Helvetica', 'normal')
    doc.setFontSize(10.5)
    doc.setTextColor(30, 41, 59)
    const lines = doc.splitTextToSize(d.giudizioGlobale, 182) as string[]
    doc.text(lines, 14, y)
    y += lines.length * 5 + 6
  }

  // Firma applicativa (chiusura dirigente)
  if (y > 250) { doc.addPage(); y = 20 }
  y = Math.max(y + 8, 262)
  doc.setDrawColor(0, 106, 95)
  doc.setLineWidth(0.4)
  doc.line(14, y, 196, y)
  y += 6
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(100, 116, 139)
  const dataChiusura = d.chiusoIl ? new Date(d.chiusoIl).toLocaleDateString('it-IT') : '—'
  const firma = d.dirigente
    ? `Documento chiuso e validato dal Dirigente ${d.dirigente} il ${dataChiusura}.`
    : `Documento chiuso il ${dataChiusura}.`
  doc.text(firma, 14, y)
  y += 4
  doc.setFontSize(7.5)
  doc.setTextColor(148, 163, 184)
  doc.text('Firma applicativa — la firma digitale qualificata non è richiesta in questa fase.', 14, y)

  return Buffer.from(doc.output('arraybuffer'))
}
