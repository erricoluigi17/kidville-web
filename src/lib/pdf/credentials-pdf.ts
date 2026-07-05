import { jsPDF } from 'jspdf'

// PDF credenziali (rigenerazione presidiata dalla Segreteria). Stesso stile dei
// PDF esistenti (receipt-pdf / pagella-pdf). Documento RISERVATO: contiene la
// password in chiaro, va consegnato all'interessato in modo sicuro.

const GREEN: [number, number, number] = [0, 106, 95]
const YELLOW: [number, number, number] = [253, 196, 0]

export interface CredentialsPdfPayload {
  schoolName?: string
  nome?: string | null
  ruolo: string
  email: string
  password: string
  loginUrl: string
  generatedAt: string
}

export function buildCredentialsPdf(p: CredentialsPdfPayload): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  doc.setFillColor(...GREEN)
  doc.rect(0, 0, 210, 38, 'F')
  doc.setFillColor(...YELLOW)
  doc.rect(0, 0, 4, 38, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(p.schoolName ?? 'Kidville', 14, 16)
  doc.setFontSize(13)
  doc.text('Credenziali di accesso', 14, 28)

  doc.setTextColor(30, 30, 30)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  let y = 54
  const line = (label: string, value: string) => {
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.text(doc.splitTextToSize(value, 150), 62, y)
    y += 9
  }

  if (p.nome) line('Intestatario:', p.nome)
  line('Ruolo:', p.ruolo)
  line('Indirizzo web:', p.loginUrl)
  line('Email / username:', p.email)
  line('Password:', p.password)
  line('Generato il:', p.generatedAt)

  y += 6
  doc.setFillColor(255, 247, 224)
  doc.rect(14, y, 182, 20, 'F')
  doc.setTextColor(120, 80, 0)
  doc.setFontSize(9)
  doc.text(
    'Consegnare queste credenziali all’interessato in modo riservato. Si consiglia di cambiare la password al primo accesso.',
    18,
    y + 8,
    { maxWidth: 174 }
  )

  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text('Documento riservato generato dalla Segreteria Kidville.', 14, 285, { maxWidth: 182 })

  return Buffer.from(doc.output('arraybuffer'))
}
