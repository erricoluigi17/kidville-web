import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { caricaFigliConTarget, postVisibileAiFigli, type FiglioTarget, type PostTarget } from '@/lib/news/target'
import { schemaAssente } from '@/lib/news/schema-assente'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zAnnoMese } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// GET /api/news/feed — feed delle news pubblicate.
//
// Ramo GENITORE: server-derived e FAIL-CLOSED. I figli (sede/grado/classe) si
// ricavano dalla sessione con `caricaFigliConTarget`; senza un figlio dalla sede
// determinabile non si mostra NULLA (un globale cross-sede non deve trapelare).
// Il set candidato (pubblicati delle sedi dei figli + globali) è poi filtrato con
// `postVisibileAiFigli` (pura). Ramo STAFF/DOCENTE/CUOCA: pubblicati delle proprie
// sedi (`resolveScuoleAttive`) + globali, senza filtro per-figlio.
//
// Filtri: ?q= (full-text `italian` via websearch), ?categoria_id=, ?mese=YYYY-MM,
// ?limit= (widget home), ?archivio=1 (aggregato [{mese, conteggio}]).
//
// DB E2E della CI non migrato: colonna/tabella assente (42P01/42703/PGRST205) →
// {disponibile:false} + lista vuota, MAI 500.
// =============================================================================

const FEED_COLS =
  'id, tipo, stato, titolo, contenuto_html, contenuto_testo, categoria_id, pubblicata_il, pinned, target_scope, target_gradi, target_classes, copertina_url, instagram_url, instagram_shortcode, scuola_id, created_at'

const zScuolaOpt = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  categoria_id: zScuolaOpt,
  mese: zAnnoMese.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  archivio: z.preprocess((v) => (v === '1' || v === 'true' ? true : undefined), z.boolean().optional()),
})

type FeedPost = PostTarget & {
  id: string
  pinned: boolean
  pubblicata_il: string | null
  [k: string]: unknown
}

function estremiMese(mese: string): { inizio: string; fine: string } {
  const [y, m] = mese.split('-').map(Number)
  return {
    inizio: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    fine: new Date(Date.UTC(y, m, 1)).toISOString(), // primo del mese successivo (esclusivo)
  }
}

/** Ordinamento server-side stabile: pinned prima, poi pubblicata_il DESC. */
function ordina(posts: FeedPost[]): FeedPost[] {
  return [...posts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const da = a.pubblicata_il ? Date.parse(a.pubblicata_il) : 0
    const db = b.pubblicata_il ? Date.parse(b.pubblicata_il) : 0
    return db - da
  })
}

export const GET = withRoute('news/feed:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { q: testo, categoria_id, mese, limit, archivio } = q.data

    const supabase = await createAdminClient()
    const user = auth.user

    // Sedi visibili (+ figli, per il filtro genitore).
    let sedi: string[]
    let figli: FiglioTarget[] = []
    if (user.role === 'genitore') {
      figli = await caricaFigliConTarget(supabase, user.id)
      sedi = [...new Set(figli.map((f) => f.scuola_id).filter((s): s is string => !!s))]
      if (sedi.length === 0) {
        // Fail-closed: nessun figlio con sede determinabile → niente feed.
        return NextResponse.json(archivio ? { disponibile: true, archivio: [] } : { disponibile: true, posts: [] })
      }
    } else {
      sedi = await resolveScuoleAttive(request, supabase, user)
      if (sedi.length === 0) {
        return NextResponse.json(archivio ? { disponibile: true, archivio: [] } : { disponibile: true, posts: [] })
      }
    }

    let query = supabase
      .from('news_posts')
      .select(FEED_COLS)
      .eq('stato', 'pubblicata')
      .or(`scuola_id.in.(${sedi.join(',')}),scuola_id.is.null`)
      .order('pinned', { ascending: false })
      .order('pubblicata_il', { ascending: false })
    if (categoria_id) query = query.eq('categoria_id', categoria_id)
    if (testo) query = query.textSearch('search_tsv', testo, { type: 'websearch', config: 'italian' })
    if (mese && !archivio) {
      const { inizio, fine } = estremiMese(mese)
      query = query.gte('pubblicata_il', inizio).lt('pubblicata_il', fine)
    }
    query = query.limit(200)

    const { data, error } = await query
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'feed:GET', esito: 'schema-assente' })
        return NextResponse.json(archivio ? { disponibile: false, archivio: [] } : { disponibile: false, posts: [] })
      }
      logErrore({ operazione: 'news/feed:GET', stato: 500, evento: 'news' }, error)
      return NextResponse.json({ error: 'Errore nel recupero del feed' }, { status: 500 })
    }

    let posts = (data ?? []) as unknown as FeedPost[]
    if (user.role === 'genitore') posts = posts.filter((p) => postVisibileAiFigli(p, figli))
    posts = ordina(posts)

    if (archivio) {
      const conteggi = new Map<string, number>()
      for (const p of posts) {
        if (!p.pubblicata_il) continue
        const d = new Date(p.pubblicata_il)
        if (Number.isNaN(d.getTime())) continue
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
        conteggi.set(key, (conteggi.get(key) ?? 0) + 1)
      }
      const arch = [...conteggi.entries()]
        .map(([m2, conteggio]) => ({ mese: m2, conteggio }))
        .sort((a, b) => (a.mese < b.mese ? 1 : -1))
      return NextResponse.json({ disponibile: true, archivio: arch })
    }

    if (limit) posts = posts.slice(0, limit)
    return NextResponse.json({ disponibile: true, posts })
  } catch (err) {
    logErrore({ operazione: 'news/feed:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
