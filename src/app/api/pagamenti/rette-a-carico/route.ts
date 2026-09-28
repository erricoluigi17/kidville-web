import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { caricaLegamiRetta } from '@/lib/pagamenti/rette-a-carico-server'
import type { LegameRetta } from '@/lib/pagamenti/rette-a-carico'

/**
 * GET /api/pagamenti/rette-a-carico — chi paga la retta di chi, per la vista Rette.
 *
 * Il bambino con `retta_a_carico_di` non riceve la retta (la paga un fratello), e il
 * cruscotto lo mostrava «Non generata». Questa GET gli dà il nome di chi paga. Lo stato
 * della retta del pagante NON viaggia qui: il cruscotto lo prende dalla stessa mappa che
 * disegna la riga del pagante, così il badge non può divergere da quella riga.
 *
 * Proiezione minima: del bambino esce solo l'uuid (il cruscotto ha già il resto).
 */
const OPERAZIONE = 'pagamenti/rette-a-carico:GET'

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())
const getQuerySchema = z.object({
  scuola_id: zUuidQueryOpzionale,
  /** Lo manda il cruscotto su tutte le sue GET; qui non serve a niente. */
  userId: z.string().optional(),
})

// Il nome si scrive per esteso e non come `OPERAZIONE`: `logging-coverage` lo legge dal
// sorgente per verificare che dica davvero quale route è, e una costante non la vedrebbe.
export const GET = withRoute('pagamenti/rette-a-carico:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const attive = await resolveScuoleAttive(request, supabase, user)
    const sedi = restringiSedi(attive, q.data.scuola_id)
    if (!sedi) return rifiutoSede('SEDE_NON_ACCESSIBILE')

    const esito = await caricaLegamiRetta(supabase, {
      sediBambini: sedi,
      sediPaganti: await scuoleDiUtente(supabase, user),
      operazione: OPERAZIONE,
    })
    if (!esito.ok) {
      return NextResponse.json(
        { error: 'Non è stato possibile leggere chi paga la retta per un fratello.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      )
    }
    const data: LegameRetta[] = esito.legami.map(({ alunno_id, scuola_id, pagante }) => ({ alunno_id, scuola_id, pagante }))
    // Il conteggio, senza persistere: la GET parte a ogni apertura della Contabilità.
    logEvento('pagamento', 'info', { operazione: OPERAZIONE, esito: 'letti', n: data.length, sedi: sedi.length }, undefined, { persisti: false })
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    // Con codice anche qui (lock `errori-con-codice`): la route è di sola lettura, quindi
    // un'eccezione imprevista significa comunque «non sono riuscito a leggere, riprova».
    return NextResponse.json({ error: 'Internal Server Error', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})
