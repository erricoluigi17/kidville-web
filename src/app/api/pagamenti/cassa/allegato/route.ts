import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { CASSA_BUCKET } from '@/lib/cassa/store'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// MODULO CASSA · download del giustificativo (contratto §3.5).
//
// SEMPRE via URL firmato a 300s, mai getPublicUrl. Il `path` deve iniziare con
// una sede accessibile all'utente (`resolveScuoleAttive`): impedisce di sfilare
// il giustificativo di un'altra sede indovinandone il path.
// =============================================================================

const getQuerySchema = z.object({
  path: z.string().min(1).max(500),
})

export const GET = withRoute('pagamenti/cassa/allegato:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { path } = q.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    const prefissoSede = path.split('/')[0]
    if (!prefissoSede || !sedi.includes(prefissoSede)) {
      return NextResponse.json({ error: 'Allegato non accessibile' }, { status: 403 })
    }

    const { data, error } = await supabase.storage.from(CASSA_BUCKET).createSignedUrl(path, 300)
    if (error || !data?.signedUrl) {
      logErrore({ operazione: 'pagamenti/cassa/allegato:GET', stato: 404, evento: 'storage' }, error)
      return NextResponse.json({ error: 'Allegato non trovato' }, { status: 404 })
    }

    return NextResponse.json({ url: data.signedUrl })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/allegato:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
