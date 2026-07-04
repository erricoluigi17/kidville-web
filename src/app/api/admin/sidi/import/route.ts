import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { parseSidiZip } from '@/lib/sidi/zip-parser'
import { applySidiBatch } from '@/lib/sidi/import-apply'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso (userId è consumato dal gate)

// Il file si valida come presenza/istanza (contratto attuale: qualunque valore
// non-stringa passato in formData); il contenuto .zip non è materia di zod.
type UploadedFile = { name?: string; arrayBuffer: () => Promise<ArrayBuffer> }
const postFormSchema = z.object({
  file: z.custom<UploadedFile>((v) => Boolean(v) && typeof v !== 'string', { error: 'File .zip mancante' }),
})

const patchBodySchema = z.object({
  // batchId è un id di batch: min(1) come il check attuale (niente zUuid:
  // il contratto odierno accetta qualunque stringa non vuota; il not-found è gestito da applySidiBatch).
  batchId: z.string().min(1, 'batchId obbligatorio'),
})

// GET /api/admin/sidi/import?userId=  — batch di import recenti.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  try {
    const supabase = await createAdminClient()
    const { data } = await supabase
      .from('sidi_import_batches')
      .select('id, filename, stato, totale_record, matched, creati, created_at, applied_at')
      .order('created_at', { ascending: false })
      .limit(20)
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/sidi/import?userId=  — upload del .zip SIDI (NON rinominato),
// parse + staging (stato 'parsed'). Ritorna l'anteprima (totale + warnings).
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const form = await request.formData()
    const f = parseData(postFormSchema, { file: form.get('file') })
    if ('response' in f) return f.response
    const { file } = f.data

    const buf = Buffer.from(await file.arrayBuffer())
    const parsed = await parseSidiZip(buf)
    const filename = file.name ?? 'sidi.zip'

    const supabase = await createAdminClient()
    // Import SIDI per singola scuola: risolvi l'unica sede di scrittura dallo scope dell'admin.
    const sw = await resolveScuolaScrittura(request, supabase, auth.user)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId

    const { data: batch, error } = await supabase
      .from('sidi_import_batches')
      .insert({
        scuola_id: scuolaId,
        filename,
        stato: 'parsed',
        totale_record: parsed.records.length,
        parsed_payload: parsed.records,
        warnings: parsed.warnings,
        caricato_da: auth.user.id,
      })
      .select('id')
      .single()
    if (error || !batch) return NextResponse.json({ error: error?.message ?? 'Staging fallito' }, { status: 500 })

    return NextResponse.json({
      success: true,
      batchId: batch.id,
      totale: parsed.records.length,
      warnings: parsed.warnings,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/sidi/import?userId=  — applica un batch alle anagrafiche.
// Riservato alla DIRIGENZA (mutazione anagrafica di massa). body: { batchId }
export async function PATCH(request: NextRequest) {
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  try {
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const res = await applySidiBatch(supabase, b.data.batchId, auth.user)
    if (res.error) return NextResponse.json({ error: res.error }, { status: res.status ?? 500 })
    return NextResponse.json({ success: true, ...res })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
