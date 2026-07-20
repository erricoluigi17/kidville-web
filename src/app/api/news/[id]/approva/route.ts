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
  esito: z.enum(['approva', 'rifiuta']),
  pubblica_subito: z.boolean().optional(),
  programmata_il: z.string().nullish(),
  motivo: z.string().nullish(),
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
      logEvento('news', 'info', { operazione: 'news/[id]/approva:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/[id]/approva:scope', stato: 500, evento: 'db' }, error)
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

// POST /api/news/[id]/approva — approva o rifiuta una PROPOSTA di un docente (solo staff).
export const POST = withRoute('news/[id]/approva:POST', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { esito, pubblica_subito, programmata_il, motivo } = b.data

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const post = sc.post!

    // Il flusso di approvazione vale solo su una proposta ancora aperta.
    if (post.stato !== 'proposta') {
      return NextResponse.json({ error: 'La news non è in attesa di approvazione' }, { status: 409 })
    }

    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { updated_at: now }
    let pubblicato = false

    if (esito === 'approva') {
      updates.approvata_da = auth.user.id
      updates.approvata_il = now
      if (programmata_il) {
        const quando = Date.parse(programmata_il)
        if (Number.isNaN(quando) || quando <= Date.now()) {
          return NextResponse.json({ error: 'Indicare una data di pubblicazione futura' }, { status: 400 })
        }
        updates.stato = 'programmata'
        updates.programmata_il = new Date(quando).toISOString()
      } else if (pubblica_subito !== false) {
        updates.stato = 'pubblicata'
        updates.pubblicata_il = now
        pubblicato = true
      } else {
        // Approvata ma tenuta come bozza pronta (nessuna pubblicazione né programmazione).
        updates.stato = 'bozza'
      }
    } else {
      updates.stato = 'bozza'
    }

    const { data, error } = await supabase.from('news_posts').update(updates).eq('id', p.data).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]/approva:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]/approva:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'approvazione' }, { status: 500 })
    }

    logEvento('news', 'info', {
      operazione: 'news/[id]/approva:POST',
      esito: esito === 'approva' ? (pubblicato ? 'approvata-pubblicata' : 'approvata') : 'rifiutata',
      post_id: p.data,
    })

    if (pubblicato) {
      const merged = { ...post, ...(data as NewsPost) }
      await notificaNewsPubblicata(supabase, {
        id: merged.id,
        titolo: merged.titolo,
        scuola_id: merged.scuola_id,
        target_scope: merged.target_scope,
        target_gradi: merged.target_gradi,
        target_classes: merged.target_classes,
        contenuto_testo: merged.contenuto_testo,
        invia_notifica: merged.invia_notifica,
        notifica_inviata_il: merged.notifica_inviata_il ?? null,
      } as PostDaNotificare)
    }

    return NextResponse.json({ disponibile: true, post: data as NewsPost, motivo: esito === 'rifiuta' ? (motivo ?? null) : undefined })
  } catch (err) {
    logErrore({ operazione: 'news/[id]/approva:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
