import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { CERTIFICATI_BUCKET } from '@/lib/competenze/certificato-store'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (getRequestUserId), non qui.
// studentId permissivo (stringa non vuota): oggi nessun vincolo di formato
// (in dev/test circolano id non-UUID).
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// GET /api/parent/competenze?studentId=&userId=
// Certificati delle Competenze del figlio (solo generati/firmati), con URL di
// download firmato. Nessun leak: se il figlio non è collegato, lista vuota.
export const GET = withRoute('parent/competenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: certs } = await supabase
      .from('certificati_competenze')
      .select('id, stato, anno_scolastico, file_url')
      .eq('alunno_id', studentId)
      .in('stato', ['generato', 'firmato'])
      .order('created_at', { ascending: false })

    const out = []
    for (const c of (certs ?? []) as { id: string; stato: string; anno_scolastico: string; file_url: string | null }[]) {
      let downloadUrl: string | null = null
      if (c.file_url) {
        const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(c.file_url, 600)
        downloadUrl = signed?.signedUrl ?? null
      }
      out.push({ id: c.id, anno: c.anno_scolastico, stato: c.stato, downloadUrl })
    }
    return NextResponse.json({ success: true, data: out })
  } catch (err) {
    logErrore({ operazione: 'parent/competenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
