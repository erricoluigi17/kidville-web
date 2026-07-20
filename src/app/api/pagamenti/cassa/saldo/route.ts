import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { getModuleConfig } from '@/lib/settings/module-config'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { caricaSaldoCassa } from '@/lib/cassa/saldo'
import { verificaSogliaCassa } from '@/lib/cassa/notifiche'

const getQuerySchema = z.object({
  scuola_id: z.preprocess((v) => v || undefined, zUuid.optional()),
})

// GET /api/pagamenti/cassa/saldo?scuola_id=  — SOLO admin (KPI economico).
// «Saldo atteso in cassa» = quanto contante deve esserci nel cassetto + «entrato oggi»
// per metodo. Il fondo viene da cassa_config; caricaSaldoCassa degrada da solo a
// { disponibile:false } sul DB E2E CI non migrato (mai 500).
export const GET = withRoute('pagamenti/cassa/saldo:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    // Type-literal inline (non `CassaConfig`): un'interface non soddisfa il vincolo
    // `Record<string,unknown>` di getModuleConfig; qui serve solo il fondo.
    const config = await getModuleConfig<{ fondo?: number }>(supabase, 'cassa_config', scuolaId)
    const fondo = config.fondo ?? 0

    // caricaSaldoCassa popola già `entrato_oggi` (stessa passata sugli incassi):
    // ritornarlo com'è evita una seconda query ridondante.
    const saldo = await caricaSaldoCassa(supabase, scuolaId, fondo)

    // Best-effort a valle (transizione sotto→sopra soglia): non blocca la risposta.
    await verificaSogliaCassa(supabase, scuolaId)

    return NextResponse.json(saldo)
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/saldo:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
