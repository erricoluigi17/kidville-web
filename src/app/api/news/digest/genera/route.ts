import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { generaEInviaDigest } from '@/lib/news/digest'

// =============================================================================
// POST /api/news/digest/genera — genera (e invia) manualmente il digest di un
// mese. Idempotente (la lib garantisce ON CONFLICT DO NOTHING + guardia
// inviata_il). `scuola_id` esplicito → deve essere fra le sedi ACCESSIBILI
// (403 altrimenti); assente → si risolve la sede di scrittura corrente, che con
// più plessi e nessuna selezione risponde 400.
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

    // La sede passa da `resolveScuolaScrittura` come tutte le altre scritture:
    // dichiarata (`scuola_id`) se accessibile, altrimenti dedotta dal
    // SedeSelector o dall'unico plesso, altrimenti 400 che nomina il parametro.
    //
    // Prima il ramo esplicito validava contro `resolveScuoleAttive`, cioè contro
    // le sedi SELEZIONATE nel cookie: chiedere il digest di un plesso proprio ma
    // non selezionato rispondeva 403 «sede non accessibile» — un messaggio
    // semplicemente falso. La selezione è una preferenza di interfaccia; una
    // sede DICHIARATA nel corpo della richiesta la sovrascrive.
    //
    // Il 403 resta, e va tenuto: `resolveScuolaScrittura` IGNORA una `preferita`
    // fuori scope e ripiega sulle altre, quindi senza questo controllo una sede
    // altrui verrebbe rimpiazzata in silenzio da una propria — e il digest
    // partirebbe per il plesso sbagliato senza che nessuno l'abbia chiesto.
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id ?? undefined)
    if (scuola_id && sw.scuolaId !== scuola_id) {
      logEvento('news', 'warn', {
        operazione: 'news/digest/genera:POST',
        esito: 'sede-non-accessibile',
        utente: auth.user.id,
        ruolo: auth.user.role,
      })
      return NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 })
    }
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { edizioni } = await generaEInviaDigest(supabase, { anno, mese, scuolaId })
    logEvento('news', 'info', { operazione: 'news/digest/genera:POST', esito: 'generato', anno, mese, scuola_id: scuolaId, edizioni: edizioni.length })
    return NextResponse.json({ edizioni })
  } catch (err) {
    logErrore({ operazione: 'news/digest/genera:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
