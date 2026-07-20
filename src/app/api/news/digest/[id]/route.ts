import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { caricaFigliConTarget } from '@/lib/news/target'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { NewsDigestEdizione } from '@/lib/news/tipi'

// =============================================================================
// GET /api/news/digest/[id] — dettaglio di un'edizione (con `html`).
// Genitore: 404 se non inviata o se di una sede non dei figli (non si rivela
// l'esistenza). Staff: 404 se di una sede non accessibile.
// =============================================================================

interface RouteParams {
  params: Promise<{ id: string }>
}

const NON_TROVATA = () => NextResponse.json({ error: 'Edizione non trovata' }, { status: 404 })

export const GET = withRoute('news/digest/[id]:GET', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const user = auth.user

    const { data, error } = await supabase.from('news_digest_edizioni').select('*').eq('id', p.data).maybeSingle()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/digest/[id]:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false })
      }
      logErrore({ operazione: 'news/digest/[id]:GET', stato: 500, evento: 'news' }, error)
      return NextResponse.json({ error: 'Errore nel recupero dell\'edizione' }, { status: 500 })
    }
    if (!data) return NON_TROVATA()
    const ed = data as NewsDigestEdizione

    if (user.role === 'genitore') {
      if (!ed.inviata_il) return NON_TROVATA()
      const figli = await caricaFigliConTarget(supabase, user.id)
      const sedi = new Set(figli.map((f) => f.scuola_id).filter((s): s is string => !!s))
      if (!sedi.has(ed.scuola_id)) return NON_TROVATA()
    } else {
      const sedi = await resolveScuoleAttive(request, supabase, user)
      if (!sedi.includes(ed.scuola_id)) return NON_TROVATA()
    }

    return NextResponse.json({ disponibile: true, edizione: ed })
  } catch (err) {
    logErrore({ operazione: 'news/digest/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
