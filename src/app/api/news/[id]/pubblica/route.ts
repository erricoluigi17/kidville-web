import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { notificaNewsPubblicata, type PostDaNotificare } from '@/lib/news/notifiche'
import type { NewsPost } from '@/lib/news/tipi'

interface RouteParams {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({
  azione: z.enum(['pubblica', 'programma', 'ritira', 'ripubblica', 'pin']),
  programmata_il: z.string().nullish(),
  pinned: z.boolean().optional(),
})

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
      logEvento('news', 'info', { operazione: 'news/[id]/pubblica:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/[id]/pubblica:scope', stato: 500, evento: 'db' }, error)
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

function postDaNotificare(post: NewsPost): PostDaNotificare {
  return {
    id: post.id,
    titolo: post.titolo,
    scuola_id: post.scuola_id,
    target_scope: post.target_scope,
    target_gradi: post.target_gradi,
    target_classes: post.target_classes,
    contenuto_testo: post.contenuto_testo,
    invia_notifica: post.invia_notifica,
    notifica_inviata_il: post.notifica_inviata_il ?? null,
  }
}

// POST /api/news/[id]/pubblica — workflow di pubblicazione (solo staff).
export const POST = withRoute('news/[id]/pubblica:POST', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { azione, programmata_il, pinned } = b.data

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const post = sc.post!

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    switch (azione) {
      case 'pubblica':
        updates.stato = 'pubblicata'
        updates.pubblicata_il = new Date().toISOString()
        updates.nascosta_motivo = null
        // Periodo di grazia per l'health-check IG: una pubblicazione manuale riparte
        // da contatori puliti (un residuo pre-esistente nasconderebbe il post al primo tick).
        updates.ig_check_falliti = 0
        updates.ig_check_il = null
        break
      case 'programma': {
        const quando = programmata_il ? Date.parse(programmata_il) : NaN
        if (Number.isNaN(quando) || quando <= Date.now()) {
          return NextResponse.json({ error: 'Indicare una data di pubblicazione futura' }, { status: 400 })
        }
        updates.stato = 'programmata'
        updates.programmata_il = new Date(quando).toISOString()
        break
      }
      case 'ritira':
        updates.stato = 'nascosta'
        updates.nascosta_motivo = 'ritirata'
        break
      case 'ripubblica':
        // NON ri-notifica: `notifica_inviata_il` resta invariato e non chiamiamo la notifica.
        updates.stato = 'pubblicata'
        updates.nascosta_motivo = null
        // Il ripristino manuale azzera i fallimenti dell'health-check IG: senza reset,
        // un post nascosto per `ig_check_falliti >= 2` tornerebbe nascosto ai tick successivi.
        updates.ig_check_falliti = 0
        updates.ig_check_il = null
        break
      case 'pin':
        updates.pinned = pinned ?? !post.pinned
        break
    }

    const { data, error } = await supabase.from('news_posts').update(updates).eq('id', p.data).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]/pubblica:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]/pubblica:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella pubblicazione' }, { status: 500 })
    }

    logEvento('news', 'info', { operazione: 'news/[id]/pubblica:POST', esito: azione, post_id: p.data })

    // La notifica parte solo su una vera pubblicazione (la guardia interna evita i doppioni).
    if (azione === 'pubblica') {
      await notificaNewsPubblicata(supabase, postDaNotificare({ ...post, ...(data as NewsPost) }))
    }

    return NextResponse.json({ disponibile: true, post: data as NewsPost })
  } catch (err) {
    logErrore({ operazione: 'news/[id]/pubblica:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
