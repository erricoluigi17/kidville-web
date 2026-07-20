import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { caricaFigliConTarget, postVisibileAiFigli, type PostTarget } from '@/lib/news/target'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { NewsMedia, NewsPost } from '@/lib/news/tipi'

// =============================================================================
// GET /api/news/feed/[id] — dettaglio di un post pubblicato, con RI-VERIFICA del
// target sul singolo post: fuori target → 404 (non 403: non si rivela l'esistenza
// di un contenuto non destinato). Solo il GENITORE registra la visualizzazione
// (upsert best-effort su news_visualizzazioni; l'errore si logga warn ma non blocca).
// =============================================================================

interface RouteParams {
  params: Promise<{ id: string }>
}

// Colonne del dettaglio esposto al lettore. Curate (privacy): niente campi
// editoriali/interni (author_id, approvata_da/_il, nascosta_motivo, ig_check_*,
// notifica_inviata_il, invia_notifica, contenuto_json). Restano quelle che servono
// al gate/targeting (stato, scuola_id, target_*) e al rendering.
const POST_COLS = 'id, tipo, stato, titolo, contenuto_html, categoria_id, pubblicata_il, pinned, target_scope, target_gradi, target_classes, copertina_url, instagram_url, instagram_shortcode, scuola_id'

const MEDIA_COLS = 'id, post_id, tipo, url, poster_url, ordine'

const NON_TROVATA = () => NextResponse.json({ error: 'News non trovata' }, { status: 404 })

export const GET = withRoute('news/feed/[id]:GET', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const user = auth.user

    const { data, error } = await supabase.from('news_posts').select(POST_COLS).eq('id', p.data).maybeSingle()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/feed/[id]:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false })
      }
      logErrore({ operazione: 'news/feed/[id]:GET', stato: 500, evento: 'news' }, error)
      return NextResponse.json({ error: 'Errore nel recupero della news' }, { status: 500 })
    }
    if (!data) return NON_TROVATA()
    const post = data as NewsPost
    if (post.stato !== 'pubblicata') return NON_TROVATA()

    // Ri-verifica il target su QUESTO post: fuori target → 404 (non 403).
    if (user.role === 'genitore') {
      const figli = await caricaFigliConTarget(supabase, user.id)
      if (!postVisibileAiFigli(post as PostTarget, figli)) return NON_TROVATA()
    } else {
      const sedi = await resolveScuoleAttive(request, supabase, user)
      if (post.scuola_id != null && !sedi.includes(post.scuola_id)) return NON_TROVATA()
    }

    // Media ordinati.
    const { data: media, error: mediaErr } = await supabase
      .from('news_media')
      .select(MEDIA_COLS)
      .eq('post_id', p.data)
      .order('ordine', { ascending: true })
    if (mediaErr && !schemaAssente(mediaErr)) {
      logErrore({ operazione: 'news/feed/[id]:media', stato: 500, evento: 'news' }, mediaErr)
    }

    // Solo i genitori contano fra le visualizzazioni (decisione 10). Best-effort:
    // un errore d'upsert si logga ma non blocca la risposta.
    if (user.role === 'genitore') {
      const { error: visErr } = await supabase
        .from('news_visualizzazioni')
        .upsert({ post_id: p.data, utente_id: user.id }, { onConflict: 'post_id,utente_id', ignoreDuplicates: true })
      if (visErr && !schemaAssente(visErr)) {
        logEvento('news', 'warn', { operazione: 'news/feed/[id]:vista', esito: 'upsert-fallito', post_id: p.data }, visErr)
      }
    }

    return NextResponse.json({ disponibile: true, post, media: (media ?? []) as NewsMedia[] })
  } catch (err) {
    logErrore({ operazione: 'news/feed/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
