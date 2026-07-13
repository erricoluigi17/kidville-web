import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { CERTIFICATI_BUCKET } from '@/lib/competenze/certificato-store'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// certificatoId permissivo (stringa non vuota, niente zUuid): oggi nessun
// vincolo di formato. `userId` in query è consumato dal gate (requireStaff).
const getQuerySchema = z.object({
  certificatoId: z.string({ error: 'certificatoId obbligatorio' }).min(1, 'certificatoId obbligatorio'),
})

// GET /api/admin/competenze/download?certificatoId=&userId=
// URL firmato del PDF del certificato (lato staff/dirigenza).
export const GET = withRoute('admin/competenze/download:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { certificatoId } = q.data

    const supabase = await createAdminClient()
    const { data: cert } = await supabase
      .from('certificati_competenze')
      .select('file_url')
      .eq('id', certificatoId)
      .maybeSingle()
    if (!cert?.file_url) return NextResponse.json({ error: 'Certificato non ancora generato' }, { status: 404 })

    const { data: signed } = await supabase.storage.from(CERTIFICATI_BUCKET).createSignedUrl(cert.file_url, 600)
    if (!signed?.signedUrl) return NextResponse.json({ error: 'URL non disponibile' }, { status: 500 })
    return NextResponse.json({ success: true, url: signed.signedUrl })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze/download:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
