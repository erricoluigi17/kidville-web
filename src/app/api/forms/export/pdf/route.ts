import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { jsPDF } from 'jspdf'
import type { FormSchemaConfig, FormSubmissionStatus } from '@/types/database.types'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { requireStaff } from '@/lib/auth/require-staff'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  id: zUuid,
})

const STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  draft: 'Bozza',
  pending_signature: 'In attesa di firma',
  completed: 'Completato',
}

export const GET = withRoute('forms/export/pdf:GET', async (request: NextRequest) => {
  // Gap auth segnalato in M3, chiuso in M9: il PDF contiene i dati della
  // compilazione (PII) — riservato allo staff di gestione.
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { id } = q.data

  const supabase = await createAdminClient()

  const { data: submission, error } = await supabase
    .from('form_submissions')
    .select('*, form_model:form_models(id, title, schema)')
    .eq('id', id)
    .maybeSingle()

  if (error || !submission) {
    return NextResponse.json({ error: 'Compilazione non trovata' }, { status: 404 })
  }

  // Build field label map from the form schema (excluding file/signature fields)
  const fieldMap: Record<string, { label: string; type: string }> = {}
  const schema = submission.form_model?.schema as FormSchemaConfig | undefined
  if (schema?.pages) {
    for (const page of schema.pages) {
      for (const field of page.fields) {
        fieldMap[field.id] = { label: field.label, type: field.type }
      }
    }
  }

  // ── Generate PDF ──────────────────────────────────────────────
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Dark header band
  doc.setFillColor(11, 15, 31)
  doc.rect(0, 0, 210, 48, 'F')

  // Accent bar
  doc.setFillColor(99, 102, 241)
  doc.rect(0, 0, 4, 48, 'F')

  // School name
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(255, 255, 255)
  doc.text('KIDVILLE', 14, 18)

  // Sub-label
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(148, 163, 184)
  doc.text('Registro Elettronico — Riepilogo Compilazione', 14, 26)

  // Submission metadata
  doc.setFontSize(8)
  doc.setTextColor(100, 116, 139)
  doc.text(`ID: ${id.toUpperCase()}`, 14, 34)
  doc.text(
    `Data invio: ${new Date(submission.created_at).toLocaleString('it-IT')}`,
    14,
    40,
  )

  // Form title band
  doc.setFillColor(20, 28, 58)
  doc.rect(0, 50, 210, 16, 'F')
  doc.setFont('Helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(199, 210, 254)
  doc.text(submission.form_model?.title ?? 'Modulo', 14, 61)

  // Status & signature info
  let y = 76
  doc.setFont('Helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(100, 116, 139)
  doc.text(
    `Stato: ${STATUS_LABELS[submission.status as FormSubmissionStatus] ?? submission.status}`,
    14,
    y,
  )
  y += 6

  if (submission.signed_at) {
    doc.setTextColor(52, 211, 153)
    doc.text(
      `Firmato il: ${new Date(submission.signed_at).toLocaleString('it-IT')}`,
      14,
      y,
    )
    y += 6
  }

  // Divider
  y += 3
  doc.setDrawColor(30, 41, 59)
  doc.setLineWidth(0.4)
  doc.line(14, y, 196, y)
  y += 8

  // Field values
  const data = submission.data as Record<string, unknown>

  for (const [fieldId, value] of Object.entries(data)) {
    const meta = fieldMap[fieldId]

    // Skip file and signature fields as per spec
    if (meta?.type === 'file' || meta?.type === 'signature') continue
    if (value === null || value === undefined || value === '') continue

    // Page break guard
    if (y > 265) {
      doc.addPage()
      y = 18
    }

    // Field label
    doc.setFont('Helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(100, 116, 139)
    const labelText = (meta?.label ?? fieldId).toUpperCase()
    doc.text(labelText, 14, y)
    y += 5

    // Field value
    let displayValue = ''
    if (typeof value === 'boolean') displayValue = value ? 'Sì' : 'No'
    else if (Array.isArray(value)) displayValue = value.join(', ')
    else displayValue = String(value)

    doc.setFont('Helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(30, 41, 59)

    const lines = doc.splitTextToSize(displayValue, 176) as string[]
    doc.text(lines, 14, y)
    y += lines.length * 5 + 5

    // Subtle row separator
    doc.setDrawColor(241, 245, 249)
    doc.setLineWidth(0.15)
    doc.line(14, y - 1, 196, y - 1)
    y += 2
  }

  // Footer on every page
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFont('Helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(148, 163, 184)
    doc.text(
      `Kidville — Documento generato il ${new Date().toLocaleString('it-IT')} — Pagina ${p} di ${pageCount}`,
      14,
      290,
    )
  }

  const pdfBuffer = Buffer.from(doc.output('arraybuffer'))

  return new NextResponse(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="compilazione-${id.slice(0, 8)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
})
