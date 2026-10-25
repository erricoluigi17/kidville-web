import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { CERTIFICATI_BUCKET } from '@/lib/competenze/certificato-store'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/db/guasto'
import { rispostaErroreInterno } from '@/lib/api/errore-interno'

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

    // Un guasto non è «nessun certificato»: il genitore leggerebbe che il documento non
    // esiste ancora.
    const { data: certs, error: errCerts } = await supabase
      .from('certificati_competenze')
      .select('id, stato, anno_scolastico, file_url')
      .eq('alunno_id', studentId)
      .in('stato', ['generato', 'firmato'])
      .order('created_at', { ascending: false })
    if (errCerts) return rispostaGuastoDb('parent/competenze:GET', 'db:certificati_competenze', errCerts)

    const out = []
    for (const c of (certs ?? []) as { id: string; stato: string; anno_scolastico: string; file_url: string | null }[]) {
      let downloadUrl: string | null = null
      if (c.file_url) {
        const { data: signed, error: erroreFirma } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(c.file_url, 600)
        // Un link che non si firma non toglie il certificato dall'elenco: il genitore lo vede senza il pulsante
        // di download, e la riga dice perché. Fino al 20/10 il guasto spariva in questo `?? null`.
        if (erroreFirma) {
          logEvento('storage', 'error', {
            operazione: 'parent/competenze:GET',
            esito: 'url-firmato-non-creato',
            entita_id: c.id,
          }, erroreFirma)
        }
        downloadUrl = signed?.signedUrl ?? null
      }
      out.push({ id: c.id, anno: c.anno_scolastico, stato: c.stato, downloadUrl })
    }
    return NextResponse.json({ success: true, data: out })
  } catch (err) {
    return rispostaErroreInterno('parent/competenze:GET', err)
  }
})
