/**
 * Carta intestata Kidville per i documenti su richiesta (decisione #22):
 * banda verde con logo, righe di intestazione sede reali (mai inventate),
 * titolo, corpo e luogo/data; firma "La Direzione". Stesso stile dei PDF
 * esistenti (credentials-pdf / receipt-pdf). Il timbro di protocollo viene
 * apposto DOPO da applicaSegnatura. Testato in
 * __tests__/lib/protocolli-documento-pdf.test.ts.
 */

import { jsPDF } from 'jspdf'
import { LOGO_LIGHT_PNG_BASE64 } from '@/lib/protocolli/assets'

const VERDE: [number, number, number] = [0, 106, 95]
const GRIGIO: [number, number, number] = [100, 100, 100]
const INCHIOSTRO: [number, number, number] = [45, 45, 45]

export function buildDocumentoRichiestaPdf(input: {
  intestazione: string[]
  titolo: string
  corpo: string
  luogoData: string
}): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Banda verde con logo (620×209 → 44×14,8 mm)
  doc.setFillColor(...VERDE)
  doc.rect(0, 0, 210, 30, 'F')
  doc.addImage(LOGO_LIGHT_PNG_BASE64, 'PNG', 14, 7.5, 44, 14.8)

  // Intestazione sede (righe reali dal DB, omesse se mancanti)
  let y = 38
  if (input.intestazione.length > 0) {
    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    for (const riga of input.intestazione) {
      doc.text(riga, 105, y, { align: 'center' })
      y += 4.5
    }
  }

  // Titolo
  y = Math.max(y + 12, 58)
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(input.titolo, 105, y, { align: 'center' })
  doc.setDrawColor(...VERDE)
  doc.line(40, y + 4, 170, y + 4)

  // Corpo
  y += 16
  doc.setTextColor(...INCHIOSTRO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  const righeCorpo = doc.splitTextToSize(input.corpo, 166) as string[]
  doc.text(righeCorpo, 22, y)
  y += righeCorpo.length * 6.2

  // Luogo e data + firma
  y = Math.min(Math.max(y + 18, 150), 240)
  doc.setFontSize(11)
  doc.text(input.luogoData, 22, y)
  doc.setFont('helvetica', 'bold')
  doc.text('La Direzione', 152, y, { align: 'center' })
  doc.setDrawColor(...GRIGIO)
  doc.line(128, y + 14, 176, y + 14)

  // Piè di pagina
  doc.setFont('helvetica', 'italic')
  doc.setFontSize(8)
  doc.setTextColor(...GRIGIO)
  doc.text('Documento generato dal registro elettronico Kidville', 105, 287, { align: 'center' })

  return new Uint8Array(doc.output('arraybuffer'))
}
