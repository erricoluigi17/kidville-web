import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity } from '@/lib/auth/require-staff'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'

const BUCKET = 'sensitive_documents'
const SIGNED_TTL = 60 // secondi

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  documentoId: zUuid,
  finalita: z.string().optional(),
})

// GET /api/primaria/fascicolo/file?documentoId=&userId=
// Restituisce un signed URL a tempo per il download del documento (RBAC + audit).
export const GET = withRoute('primaria/fascicolo/file:GET', async (request: NextRequest) => {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { documentoId, finalita } = q.data

    const supabase = await createAdminClient()
    // Un documento nel cestino non si scarica: per il fascicolo è eliminato, e si
    // riapre solo dopo un «Ripristina» (`…/fascicolo/cestino`).
    const { data: doc, error: erroreDoc } = await fascicoloVivo(
      supabase
        .from('student_documents')
        .select('id, student_id, storage_path, file_url, file_name')
        .eq('id', documentoId),
    ).maybeSingle()
    if (erroreDoc) {
      logErrore({ operazione: 'primaria/fascicolo/file:GET', stato: 500, evento: `student_documents:${erroreDoc.code ?? 'ignoto'}` }, erroreDoc)
      return NextResponse.json({ error: 'Lettura del documento non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }
    if (!doc) return NextResponse.json({ error: 'Documento non trovato' }, { status: 404 })

    const access = await puoAccedereFascicolo(supabase, userId, doc.student_id)
    if (!access.consentito) return NextResponse.json({ error: 'Accesso non consentito' }, { status: 403 })

    const path = doc.storage_path || doc.file_url
    if (!path) return NextResponse.json({ error: 'File non disponibile' }, { status: 404 })

    const { data: signed, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL)
    if (error || !signed?.signedUrl) {
      // Il messaggio dello Storage resta nel LOG e non torna al chiamante: può nominare
      // bucket e percorso del file, cioè l'alunno e il tipo di documento (diagnosi, PEI,
      // verbali della 104). Al client basta il codice, che si traduce.
      logErrore(
        { operazione: 'primaria/fascicolo/file:GET', stato: 500, evento: error ? 'storage:createSignedUrl' : 'storage:signedUrl_vuoto' },
        error ?? new Error('createSignedUrl senza errore e senza URL'),
      )
      return NextResponse.json({ error: 'Apertura del documento non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    await logAccessoFascicolo(supabase, { alunnoId: doc.student_id, utenteId: userId, azione: 'download', documentoId, finalita, request })

    return NextResponse.json({ success: true, data: { url: signed.signedUrl, fileName: doc.file_name } })
  } catch (err) {
    // Come in `primaria/fascicolo`: il testo dell'eccezione vive nel log, non nella
    // risposta. Su questa rotta può nominare tabelle, colonne e percorsi dello Storage.
    logErrore({ operazione: 'primaria/fascicolo/file:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})
