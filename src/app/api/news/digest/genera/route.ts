import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { generaEInviaDigest } from '@/lib/news/digest'

// =============================================================================
// POST /api/news/digest/genera — genera (e invia) manualmente il digest di un
// mese. Idempotente (la lib garantisce ON CONFLICT DO NOTHING + guardia
// inviata_il). `scuola_id` esplicito → deve essere fra le sedi accessibili (403),
// altrimenti si risolve la sede di scrittura corrente.
// =============================================================================

const bodySchema = z.object({
  anno: z.coerce.number().int().min(2000).max(2100),
  mese: z.coerce.number().int().min(1).max(12),
  scuola_id: zUuid.nullish(),
})

export const POST = withRoute('news/digest/genera:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { anno, mese, scuola_id } = b.data

    const supabase = await createAdminClient()

    // La sede: se esplicita, deve essere accessibile (mai fidarsi del client per il tenant).
    let scuolaId: string
    if (scuola_id) {
      const sedi = await resolveScuoleAttive(request, supabase, auth.user)
      if (!sedi.includes(scuola_id)) {
        return NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 })
      }
      scuolaId = scuola_id
    } else {
      const sw = await resolveScuolaScrittura(request, supabase, auth.user)
      if (sw.response) return sw.response
      scuolaId = sw.scuolaId as string
    }

    const { edizioni } = await generaEInviaDigest(supabase, { anno, mese, scuolaId })
    logEvento('news', 'info', { operazione: 'news/digest/genera:POST', esito: 'generato', anno, mese, scuola_id: scuolaId, edizioni: edizioni.length })
    return NextResponse.json({ edizioni })
  } catch (err) {
    logErrore({ operazione: 'news/digest/genera:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
