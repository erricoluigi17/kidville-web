import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const BUCKET = 'certificati-medici'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  id: zUuid,
})

// GET /api/parent/medical-certificates/file?id=  — scarica il certificato (dato
// sanitario). Accesso: staff oppure genitore collegato all'alunno.
export const GET = withRoute('parent/medical-certificates/file:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const { data: cert } = await supabase
      .from('certificati_medici')
      .select('id, alunno_id, file_path')
      .eq('id', id)
      .maybeSingle()
    if (!cert) return NextResponse.json({ error: 'Certificato non trovato' }, { status: 404 })

    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria' || user.role === 'educator'
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
        .eq('alunno_id', cert.alunno_id)
        .maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data: file, error } = await supabase.storage.from(BUCKET).download(cert.file_path)
    if (error || !file) return NextResponse.json({ error: 'File non disponibile' }, { status: 404 })

    const buf = Buffer.from(await file.arrayBuffer())
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(cert.file_path as string).split('/').pop()}"`,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'parent/medical-certificates/file:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
