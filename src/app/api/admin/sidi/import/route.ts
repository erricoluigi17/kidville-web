import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseSidiZip } from '@/lib/sidi/zip-parser'
import { applySidiBatch } from '@/lib/sidi/import-apply'

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

// GET /api/admin/sidi/import?userId=  — batch di import recenti.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
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
    const file = form.get('file')
    if (!file || typeof file === 'string') return NextResponse.json({ error: 'File .zip mancante' }, { status: 400 })

    const buf = Buffer.from(await (file as Blob).arrayBuffer())
    const parsed = await parseSidiZip(buf)
    const scuolaId = auth.user.scuola_id || SCUOLA_ID_DEFAULT
    const filename = (file as File).name ?? 'sidi.zip'

    const supabase = await createAdminClient()
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
    const body = await request.json().catch(() => ({}))
    if (!body.batchId) return NextResponse.json({ error: 'batchId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const res = await applySidiBatch(supabase, body.batchId, auth.user)
    if (res.error) return NextResponse.json({ error: res.error }, { status: res.status ?? 500 })
    return NextResponse.json({ success: true, ...res })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
