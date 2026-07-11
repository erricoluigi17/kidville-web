import { jsPDF } from 'jspdf'

// Builder jsPDF dell'ordine d'acquisto (PO) al fornitore. Nessun accesso a DB:
// input già risolto. Un PDF per fornitore (per costruzione: un PO = un fornitore).

export interface OrdineFornitorePdfInput {
  numero: string
  data?: string | null
  committente: { denominazione?: string | null; piva?: string | null; indirizzo?: string | null; email?: string | null; telefono?: string | null }
  fornitore: { nome: string; referente?: string | null; email?: string | null; telefono?: string | null; indirizzo?: string | null; piva?: string | null }
  righe: { articolo: string; taglia: string; quantita: number }[]
  note?: string | null
}

export function buildOrdineFornitorePdf(i: OrdineFornitorePdfInput) {
  const doc = new jsPDF()
  let y = 20

  // Committente (la scuola)
  doc.setFontSize(15)
  doc.text(i.committente.denominazione || 'Ordine di acquisto', 20, y)
  y += 6
  doc.setFontSize(9)
  doc.setTextColor(110)
  const fisc = [
    i.committente.piva ? `P.IVA ${i.committente.piva}` : null,
    i.committente.email || null,
    i.committente.telefono || null,
  ].filter(Boolean).join(' · ')
  if (fisc) { doc.text(fisc, 20, y); y += 5 }
  if (i.committente.indirizzo) { doc.text(i.committente.indirizzo, 20, y); y += 5 }
  doc.setTextColor(0)
  y += 6

  doc.setFontSize(16)
  doc.text(`ORDINE D'ACQUISTO ${i.numero}`, 20, y)
  y += 7
  doc.setFontSize(9)
  doc.setTextColor(110)
  doc.text(`Data ${i.data ?? new Date().toLocaleDateString('it-IT')}`, 20, y)
  y += 9
  doc.setTextColor(0)

  // Fornitore
  doc.setFontSize(11)
  doc.text('Spett.le fornitore:', 20, y); y += 6
  doc.setFontSize(12)
  doc.text(i.fornitore.nome || '—', 20, y); y += 6
  doc.setFontSize(9)
  doc.setTextColor(110)
  const contatti = [
    i.fornitore.referente ? `Ref. ${i.fornitore.referente}` : null,
    i.fornitore.email || null,
    i.fornitore.telefono || null,
  ].filter(Boolean).join(' · ')
  if (contatti) { doc.text(contatti, 20, y); y += 5 }
  if (i.fornitore.piva) { doc.text(`P.IVA ${i.fornitore.piva}`, 20, y); y += 5 }
  doc.setTextColor(0)
  y += 6

  // Tabella articoli
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text('Articolo', 20, y)
  doc.text('Taglia', 130, y)
  doc.text('Q.tà', 175, y)
  doc.setTextColor(0)
  y += 3
  doc.setDrawColor(200)
  doc.line(20, y, 190, y)
  y += 6

  let totaleQ = 0
  for (const r of i.righe) {
    if (y > 270) { doc.addPage(); y = 20 }
    doc.text(String(r.articolo).slice(0, 60), 20, y)
    doc.text(r.taglia || '—', 130, y)
    doc.text(String(r.quantita), 178, y)
    totaleQ += r.quantita
    y += 6
  }
  y += 2
  doc.setDrawColor(200)
  doc.line(20, y, 190, y)
  y += 6
  doc.setFontSize(11)
  doc.text(`Totale pezzi: ${totaleQ}`, 20, y)
  y += 9

  if (i.note) {
    doc.setFontSize(9)
    doc.setTextColor(110)
    const righe = doc.splitTextToSize(`Note: ${i.note}`, 170) as string[]
    doc.text(righe, 20, y)
    doc.setTextColor(0)
  }

  return Buffer.from(doc.output('arraybuffer'))
}
