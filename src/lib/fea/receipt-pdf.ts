import { jsPDF } from 'jspdf'
import { createHash } from 'crypto'
import type { ReceiptPayload } from './types'

/**
 * Serializzazione canonica (chiavi ordinate ricorsivamente) per un hash stabile,
 * indipendente dall'ordine d'inserimento delle proprietà.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/**
 * Hash documentale della ricevuta: SHA-256 di (documento canonico + metadati
 * firma canonici). È l'ancora di inattaccabilità, distinto dall'hash OTP: se il
 * documento o i metadati firma cambiano, l'hash cambia.
 */
export function computeContentHash(documentPayload: unknown, signatureMeta: unknown): string {
  const material = `${canonicalJson(documentPayload)}|${canonicalJson(signatureMeta)}`
  const h = createHash('sha256').update(material).digest('hex')
  return `SHA256-${h.toUpperCase()}`
}

const GREEN: [number, number, number] = [0, 106, 95]
const YELLOW: [number, number, number] = [253, 196, 0]

/**
 * Ricevuta di firma inattaccabile (FEA in-house, DL-001). Riusa lo stile dei PDF
 * esistenti (pagella-pdf / forms export). Riporta firmatario, metodo/provider,
 * IP, User-Agent, timestamp, hash OTP, hash documentale e nota di compliance.
 */
export function buildReceiptPdf(payload: ReceiptPayload): Buffer {
  const { signature: s } = payload
  const contentHash = computeContentHash(payload.documentPayload, {
    method: s.method,
    email: s.email,
    signed_at: s.signed_at,
    hash: s.hash ?? null,
  })

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Header band
  doc.setFillColor(...GREEN)
  doc.rect(0, 0, 210, 38, 'F')
  doc.setFillColor(...YELLOW)
  doc.rect(0, 0, 4, 38, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(payload.schoolName ?? 'Kidville', 14, 16)
  doc.setFontSize(13)
  doc.text(payload.title, 14, 28)

  // Corpo
  doc.setTextColor(30, 30, 30)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  let y = 52
  const line = (label: string, value: string) => {
    doc.setFont('helvetica', 'bold')
    doc.text(label, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.text(doc.splitTextToSize(value, 150), 60, y)
    y += 9
  }

  line('Firmatario:', payload.signer.name ? `${payload.signer.name} <${payload.signer.email}>` : payload.signer.email)
  line('Documento:', `${payload.entitaTipo} · ${payload.entitaId}`)
  line('Metodo:', `${s.method} — ${s.provider}`)
  line('Data/ora firma:', s.signed_at)
  line('Indirizzo IP:', s.ip)
  line('User-Agent:', s.user_agent)
  if (s.hash) line('Hash OTP:', s.hash)
  line('Hash documento:', contentHash)
  line('Conformità:', s.compliance)

  // Tabella firmatari (firma congiunta) se più di uno slot
  const slots = payload.slots ?? []
  if (slots.length > 1) {
    y += 4
    doc.setFont('helvetica', 'bold')
    doc.text('Firme raccolte', 14, y)
    y += 7
    doc.setFont('helvetica', 'normal')
    for (const slot of slots) {
      const stato = slot.stato === 'signed' ? 'FIRMATO' : 'in attesa'
      doc.text(`Slot ${slot.slot_index + 1}: ${stato}${slot.firmato_il ? ` — ${slot.firmato_il}` : ''}`, 18, y)
      y += 7
    }
  }

  // Footer
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text(
    'Ricevuta generata automaticamente. La validità della firma è garantita dall’hash documentale e dall’audit immutabile.',
    14,
    285,
    { maxWidth: 182 }
  )

  return Buffer.from(doc.output('arraybuffer'))
}
