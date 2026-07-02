import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import * as XLSX from 'xlsx'
import type { FormSchemaConfig, FormSubmissionStatus } from '@/types/database.types'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  // lista di id separati da virgola; voci vuote tollerate (split+trim+filter come prima)
  ids: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(zUuid))
    .optional(),
  form_id: zUuid.or(z.literal('')).optional(), // '' tollerato: filtro saltato (comportamento invariato)
  status: z.string().optional(), // passato com'è alla query (oggi nessun enum imposto)
})

const STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  draft: 'Bozza',
  pending_signature: 'In attesa di firma',
  completed: 'Completato',
}

export async function GET(request: NextRequest) {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { ids, form_id: formId, status: statusFilter } = q.data

  const supabase = await createAdminClient()

  let query = supabase
    .from('form_submissions')
    .select('*, form_model:form_models(id, title, schema)')
    .order('created_at', { ascending: false })

  if (ids && ids.length > 0) query = query.in('id', ids)
  if (formId) query = query.eq('model_id', formId)
  if (statusFilter) query = query.eq('status', statusFilter as FormSubmissionStatus)

  const { data: submissions, error } = await query

  if (error || !submissions) {
    return NextResponse.json({ error: 'Errore recupero compilazioni' }, { status: 500 })
  }

  // Collect the union of all field IDs across submissions (excluding file/signature)
  const fieldMetaMap: Record<string, { label: string; type: string }> = {}
  for (const sub of submissions) {
    const schema = sub.form_model?.schema as FormSchemaConfig | undefined
    if (schema?.pages) {
      for (const page of schema.pages) {
        for (const field of page.fields) {
          if (field.type !== 'file' && field.type !== 'signature') {
            fieldMetaMap[field.id] = { label: field.label, type: field.type }
          }
        }
      }
    }
  }

  const fieldIds = Object.keys(fieldMetaMap)

  // Build flat row objects
  const rows = submissions.map(sub => {
    const data = sub.data as Record<string, unknown>

    const row: Record<string, string> = {
      'ID Compilazione': sub.id,
      'Modello': sub.form_model?.title ?? '',
      'Stato': STATUS_LABELS[sub.status as FormSubmissionStatus] ?? sub.status,
      'Firmato il': sub.signed_at
        ? new Date(sub.signed_at).toLocaleString('it-IT')
        : '',
      'Creato il': new Date(sub.created_at).toLocaleString('it-IT'),
    }

    for (const fieldId of fieldIds) {
      const meta = fieldMetaMap[fieldId]
      const value = data[fieldId]

      let display = ''
      if (value === null || value === undefined) display = ''
      else if (typeof value === 'boolean') display = value ? 'Sì' : 'No'
      else if (Array.isArray(value)) display = value.join(', ')
      else display = String(value)

      row[meta.label] = display
    }

    return row
  })

  // Build workbook
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Compilazioni')

  // Auto column widths
  const colWidths = Object.keys(rows[0] ?? {}).map(key => ({
    wch: Math.max(key.length, ...rows.map(r => String(r[key] ?? '').length), 10),
  }))
  ws['!cols'] = colWidths

  // SheetJS returns Buffer in Node.js; cast to ArrayBuffer for NextResponse
  const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
  const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  const arrayBuffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  )
  const blob = new Blob([new Uint8Array(arrayBuffer as ArrayBuffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  return new NextResponse(blob, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="compilazioni.xlsx"',
      'Cache-Control': 'no-store',
    },
  })
}
