import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { infoSospensioneFamiglia } from '@/lib/pagamenti/sospensione'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// GET leggera per il banner genitore: è la MIA famiglia sospesa? quanto scaduto?
// L'identità viene SEMPRE dal gate (requireUser): nessun parametro può leggere i
// dati di un'altra famiglia. Ritorna solo aggregati (sospeso + totale scaduto).
const getQuerySchema = z.object({})

export const GET = withRoute('pagamenti/sospensione-stato:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const info = await infoSospensioneFamiglia(supabase, auth.user.id)

    return NextResponse.json({ success: true, data: info })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/sospensione-stato:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
