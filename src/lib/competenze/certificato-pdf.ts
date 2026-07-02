import { jsPDF } from 'jspdf'
import { LIVELLI, livelloEtichetta } from './modello'

export interface CertificatoData {
  scuolaNome: string
  classe: string
  anno: string
  alunno: string
  alunnoNato?: string | null
  codiceFiscale?: string | null
  competenze: { etichetta: string; livello: 'A' | 'B' | 'C' | 'D' | null; note?: string | null }[]
  competenzeSignificative: string | null
  dirigente: string | null
  firmatoIl: string | null
}

/**
 * Certificato delle Competenze al termine della scuola primaria (D.M. 14/2024)
 * in PDF statico. Tabella delle 8 competenze chiave × livello A/B/C/D, legenda
 * dei 4 livelli e riga «firma applicativa» del dirigente. Riusa lo stile del PDF
 * della pagella (`src/lib/primaria/pagella-pdf.ts`).
 */
export function buildCertificatoPdf(d: CertificatoData): Buffer {
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
  doc.text('Certificazione delle Competenze — Scuola Primaria', 14, 25)
  doc.setFontSize(8)
  doc.text(`D.M. 14/2024  ·  Anno scolastico ${d.anno}  ·  Classe ${d.classe}`, 14, 32)

  // Student band
  let y = 54
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(20, 28, 40)
  doc.text(d.alunno || '—', 14, y)
  y += 6
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(100, 116, 139)
  const nato = d.alunnoNato ? new Date(d.alunnoNato).toLocaleDateString('it-IT') : null
  const meta = [nato ? `nato/a il ${nato}` : null, d.codiceFiscale ? `C.F. ${d.codiceFiscale}` : null]
    .filter(Boolean)
    .join('  ·  ')
  if (meta) doc.text(meta, 14, y)
  y += 5
  doc.setDrawColor(0, 106, 95)
  doc.setLineWidth(0.5)
  doc.line(14, y, 196, y)
  y += 9

  // Premessa
  doc.setFont('Helvetica', 'italic')
  doc.setFontSize(8.5)
  doc.setTextColor(90, 100, 115)
  {
    const premessa =
      "Il Dirigente Scolastico, visti gli atti d'ufficio relativi alle valutazioni espresse in sede di scrutinio finale, certifica che l'alunno/a ha raggiunto i livelli di competenza di seguito riportati."
    const lines = doc.splitTextToSize(premessa, 182) as string[]
    doc.text(lines, 14, y)
    y += lines.length * 4 + 6
  }

  // Competenze table header
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(0, 106, 95)
  doc.text('COMPETENZA CHIAVE EUROPEA', 14, y)
  doc.text('LIVELLO', 196, y, { align: 'right' })
  y += 3
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.2)
  doc.line(14, y, 196, y)
  y += 7

  for (const c of d.competenze) {
    if (y > 240) {
      doc.addPage()
      y = 20
    }
    doc.setFont('Helvetica', 'normal')
    doc.setFontSize(9.5)
    doc.setTextColor(30, 41, 59)
    const et = doc.splitTextToSize(c.etichetta, 150) as string[]
    doc.text(et, 14, y)
    doc.setFont('Helvetica', 'bold')
    doc.setTextColor(0, 90, 80)
    const liv = c.livello ? `${c.livello} — ${livelloEtichetta(c.livello)}` : '—'
    doc.text(liv, 196, y, { align: 'right' })
    y += Math.max(et.length * 4, 5)
    if (c.note) {
      doc.setFont('Helvetica', 'italic')
      doc.setFontSize(7.5)
      doc.setTextColor(120, 130, 145)
      const nt = doc.splitTextToSize(c.note, 180) as string[]
      doc.text(nt, 14, y)
      y += nt.length * 3.5
    }
    y += 3
    doc.setDrawColor(241, 245, 249)
    doc.setLineWidth(0.15)
    doc.line(14, y - 2, 196, y - 2)
  }

  // Competenze significative (riga libera)
  if (d.competenzeSignificative) {
    y += 6
    if (y > 235) {
      doc.addPage()
      y = 20
    }
    doc.setFont('Helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(0, 106, 95)
    doc.text('COMPETENZE SIGNIFICATIVE', 14, y)
    y += 6
    doc.setFont('Helvetica', 'normal')
    doc.setFontSize(9.5)
    doc.setTextColor(30, 41, 59)
    const lines = doc.splitTextToSize(d.competenzeSignificative, 182) as string[]
    doc.text(lines, 14, y)
    y += lines.length * 4.5 + 4
  }

  // Legenda livelli (obbligatoria sul certificato)
  y += 6
  if (y > 220) {
    doc.addPage()
    y = 20
  }
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(0, 106, 95)
  doc.text('LIVELLI', 14, y)
  y += 5
  for (const l of LIVELLI) {
    if (y > 270) {
      doc.addPage()
      y = 20
    }
    doc.setFont('Helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(60, 70, 85)
    doc.text(`${l.codice} — ${l.etichetta}:`, 14, y)
    doc.setFont('Helvetica', 'normal')
    doc.setTextColor(110, 120, 135)
    const ds = doc.splitTextToSize(l.descrittore, 150) as string[]
    doc.text(ds, 42, y)
    y += Math.max(ds.length * 3.2, 4)
  }

  // Firma applicativa (chiusura dirigente)
  if (y > 250) {
    doc.addPage()
    y = 20
  }
  y = Math.max(y + 8, 262)
  doc.setDrawColor(0, 106, 95)
  doc.setLineWidth(0.4)
  doc.line(14, y, 196, y)
  y += 6
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(100, 116, 139)
  const dataFirma = d.firmatoIl ? new Date(d.firmatoIl).toLocaleDateString('it-IT') : '—'
  const firma = d.dirigente
    ? `Certificato rilasciato e validato dal Dirigente ${d.dirigente} il ${dataFirma}.`
    : `Certificato in bozza — non ancora validato.`
  doc.text(firma, 14, y)
  y += 4
  doc.setFontSize(7.5)
  doc.setTextColor(148, 163, 184)
  doc.text('Firma applicativa — evidenza FEA in-house (ricevuta su richiesta).', 14, y)

  return Buffer.from(doc.output('arraybuffer'))
}
