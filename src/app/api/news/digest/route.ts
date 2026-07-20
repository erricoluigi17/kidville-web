import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { caricaFigliConTarget } from '@/lib/news/target'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { NewsDigestEdizione } from '@/lib/news/tipi'

// =============================================================================
// GET /api/news/digest — archivio delle edizioni del digest mensile.
//
// Genitore: SOLO le edizioni INVIATE delle sedi dei propri figli (fail-closed).
// Staff: le edizioni delle proprie sedi, anche quelle generate ma non ancora
// inviate. La LISTA non espone il campo `html` (pesante): solo il dettaglio.
// =============================================================================

// Nessun `html` in lista (colonna pesante) — solo i metadati.
const LIST_COLS = 'id, scuola_id, anno, mese, titolo, post_ids, generata_il, inviata_il, destinatari_count, errori_count'

// L'unico query param è `userId` (identità legacy via ?userId=): uuid opzionale.
// Validarlo blinda la route sotto il lock zod-coverage del gruppo `news` e chiude
// un uuid malformato con 400 invece di lasciarlo scendere fino a PostgREST.
const getQuerySchema = z.object({ userId: zUuid.optional() })

export const GET = withRoute('news/digest:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const user = auth.user

    // Sedi pertinenti.
    let sedi: string[]
    const isGenitore = user.role === 'genitore'
    if (isGenitore) {
      const figli = await caricaFigliConTarget(supabase, user.id)
      sedi = [...new Set(figli.map((f) => f.scuola_id).filter((s): s is string => !!s))]
    } else {
      sedi = await resolveScuoleAttive(request, supabase, user)
    }
    if (sedi.length === 0) {
      // Fail-closed: nessuna sede determinabile → nessuna edizione (news_digest non interrogata).
      return NextResponse.json({ disponibile: true, edizioni: [] })
    }

    let query = supabase
      .from('news_digest_edizioni')
      .select(LIST_COLS)
      .in('scuola_id', sedi)
      .order('anno', { ascending: false })
      .order('mese', { ascending: false })
    // Il genitore vede solo le edizioni realmente inviate.
    if (isGenitore) query = query.not('inviata_il', 'is', null)

    const { data, error } = await query
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/digest:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, edizioni: [] })
      }
      logErrore({ operazione: 'news/digest:GET', stato: 500, evento: 'news' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle edizioni' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, edizioni: (data ?? []) as NewsDigestEdizione[] })
  } catch (err) {
    logErrore({ operazione: 'news/digest:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
