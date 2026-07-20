import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { sanificaContenuto } from '@/lib/news/sanitizza'
import { parseInstagramUrl } from '@/lib/news/instagram'
import { NEWS_SCOPES, type NewsPost } from '@/lib/news/tipi'

interface RouteParams {
  params: Promise<{ id: string }>
}

const patchBodySchema = z.object({
  titolo: z.string().min(1).optional(),
  contenuto_json: z.unknown().optional(),
  categoria_id: zUuid.nullish(),
  target_scope: z.enum(NEWS_SCOPES).optional(),
  target_gradi: z.array(z.enum(['nido', 'infanzia', 'primaria'])).nullish(),
  target_classes: z.array(z.string()).nullish(),
  copertina_url: z.string().nullish(),
  instagram_url: z.string().nullish(),
  invia_notifica: z.boolean().optional(),
})

/**
 * RC2 — carica il post per id e verifica lo SCOPE di sede prima di ogni azione.
 * `requireDocente` verifica il RUOLO, non il TENANT, e la route gira in service-role
 * (bypassa la RLS): senza questo, si potrebbe leggere/modificare un post di un'altra
 * sede conoscendone l'UUID. Post globale (`scuola_id` NULL) gestibile da staff.
 * Ritorna la riga completa oppure una NextResponse 4xx/5xx pronta.
 */
async function caricaPostConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ post?: NewsPost; response?: NextResponse }> {
  const { data, error } = await supabase.from('news_posts').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('news', 'info', { operazione: 'news/[id]:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/[id]:scope', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nella lettura della news' }, { status: 500 }) }
  }
  if (!data) return { response: NextResponse.json({ error: 'News non trovata' }, { status: 404 }) }
  const post = data as NewsPost
  if (post.scuola_id != null) {
    const sedi = await resolveScuoleAttive(request, supabase, user)
    if (!sedi.includes(post.scuola_id)) {
      return { response: NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 }) }
    }
  }
  return { post }
}

/**
 * Un educator gestisce SOLO i propri post; per le modifiche anche solo quelli
 * ancora in `bozza`|`proposta`. Staff/direzione non sono limitati. Ritorna una
 * NextResponse 403 pronta oppure null.
 */
function guardEducator(user: AppUser, post: NewsPost, richiediEditabile: boolean): NextResponse | null {
  if (user.role !== 'educator') return null
  if (post.author_id !== user.id) {
    return NextResponse.json({ error: 'Puoi gestire solo le tue news' }, { status: 403 })
  }
  if (richiediEditabile && post.stato !== 'bozza' && post.stato !== 'proposta') {
    return NextResponse.json({ error: 'Una news già inoltrata o pubblicata non è più modificabile' }, { status: 403 })
  }
  return null
}

// GET /api/news/[id] — dettaglio gestionale.
export const GET = withRoute('news/[id]:GET', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, false)
    if (guard) return guard

    return NextResponse.json({ disponibile: true, post: sc.post })
  } catch (err) {
    logErrore({ operazione: 'news/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/news/[id] — modifica. Ri-sanifica se arriva contenuto_json.
export const PATCH = withRoute('news/[id]:PATCH', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, true)
    if (guard) return guard

    const updates: Record<string, unknown> = {}
    for (const f of ['titolo', 'categoria_id', 'target_scope', 'target_gradi', 'target_classes', 'copertina_url', 'invia_notifica'] as const) {
      if (body[f] !== undefined) updates[f] = body[f]
    }
    if (body.contenuto_json !== undefined) {
      updates.contenuto_json = body.contenuto_json ?? null
      const s = body.contenuto_json != null && typeof body.contenuto_json === 'object'
        ? sanificaContenuto(body.contenuto_json)
        : { html: null as string | null, testo: null as string | null }
      updates.contenuto_html = s.html
      updates.contenuto_testo = s.testo
    }
    if (body.instagram_url !== undefined) {
      updates.instagram_url = body.instagram_url ?? null
      updates.instagram_shortcode = body.instagram_url ? parseInstagramUrl(body.instagram_url) : null
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase.from('news_posts').update(updates).eq('id', p.data).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]:PATCH', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'aggiornamento della news' }, { status: 500 })
    }
    logEvento('news', 'info', { operazione: 'news/[id]:PATCH', esito: 'aggiornato', post_id: p.data })
    return NextResponse.json({ disponibile: true, post: data as NewsPost })
  } catch (err) {
    logErrore({ operazione: 'news/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/news/[id] — CASCADE su media/visualizzazioni. Educator: solo i propri
// post ancora in bozza|proposta.
export const DELETE = withRoute('news/[id]:DELETE', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, true)
    if (guard) return guard

    const { error } = await supabase.from('news_posts').delete().eq('id', p.data)
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]:DELETE', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]:DELETE', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'eliminazione della news' }, { status: 500 })
    }
    logEvento('news', 'info', { operazione: 'news/[id]:DELETE', esito: 'eliminato', post_id: p.data })
    return NextResponse.json({ disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'news/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
