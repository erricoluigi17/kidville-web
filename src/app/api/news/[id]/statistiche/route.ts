import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { genitoriDiGrado } from '@/lib/news/notifiche'
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import type { NewsPost } from '@/lib/news/tipi'

interface RouteParams {
  params: Promise<{ id: string }>
}

// RC2 — carica il post e verifica lo scope di sede (pattern caricaCategoriaConScope).
async function caricaPostConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ post?: NewsPost; response?: NextResponse }> {
  const { data, error } = await supabase.from('news_posts').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('news', 'info', { operazione: 'news/[id]/statistiche:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/[id]/statistiche:scope', stato: 500, evento: 'db' }, error)
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

// GET /api/news/[id]/statistiche — visualizzazioni (famiglie uniche) + famiglie target.
// Solo staff (la segreteria opera senza vedere i numeri di lettura? — decisione: le
// statistiche sono un dato gestionale dello staff, non dei genitori).
export const GET = withRoute('news/[id]/statistiche:GET', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const post = sc.post!

    // COUNT(DISTINCT utente_id) sulle visualizzazioni (le famiglie che hanno letto).
    const { data: vis, error } = await supabase
      .from('news_visualizzazioni')
      .select('utente_id')
      .eq('post_id', p.data)
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]/statistiche:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, visualizzazioni: 0, famiglie_target: 0 })
      }
      logErrore({ operazione: 'news/[id]/statistiche:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle statistiche' }, { status: 500 })
    }
    const distinte = new Set(((vis ?? []) as { utente_id: string | null }[]).map((v) => v.utente_id).filter(Boolean))

    // Denominatore: le famiglie destinatarie, con gli stessi resolver della notifica.
    let target: string[] = []
    if (post.target_scope === 'classi') {
      target = await genitoriDiClassi(supabase, post.scuola_id, post.target_classes ?? [])
    } else if (post.target_scope === 'grado') {
      target = await genitoriDiGrado(supabase, post.scuola_id, post.target_gradi)
    } else {
      target = await genitoriDiScuola(supabase, post.scuola_id)
    }

    return NextResponse.json({ visualizzazioni: distinte.size, famiglie_target: target.length })
  } catch (err) {
    logErrore({ operazione: 'news/[id]/statistiche:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
