import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const BUCKET = 'sensitive_documents'
const SIGNED_TTL = 60 // secondi

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  documentoId: zUuid,
  finalita: z.string().optional(),
})

// GET /api/primaria/fascicolo/file?documentoId=&userId=
// Restituisce un signed URL a tempo per il download del documento (RBAC + audit).
export async function GET(request: NextRequest) {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { documentoId, finalita } = q.data

    const supabase = await createAdminClient()
    const { data: doc } = await supabase
      .from('student_documents')
      .select('id, student_id, storage_path, file_url, file_name')
      .eq('id', documentoId)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Documento non trovato' }, { status: 404 })

    const access = await puoAccedereFascicolo(supabase, userId, doc.student_id)
    if (!access.consentito) return NextResponse.json({ error: 'Accesso non consentito' }, { status: 403 })

    const path = doc.storage_path || doc.file_url
    if (!path) return NextResponse.json({ error: 'File non disponibile' }, { status: 404 })

    const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL)
    if (error || !signed?.signedUrl) return NextResponse.json({ error: error?.message ?? 'Signed URL non generato' }, { status: 500 })

    await logAccessoFascicolo(supabase, { alunnoId: doc.student_id, utenteId: userId, azione: 'download', documentoId, finalita, request })

    return NextResponse.json({ success: true, data: { url: signed.signedUrl, fileName: doc.file_name } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
