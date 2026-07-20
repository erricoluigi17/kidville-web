import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import type { NewsCategoria } from '@/lib/news/tipi'

// =============================================================================
// /api/news/categorie — clone del pattern pagamenti/cassa/categorie. GET
// requireDocente (globali + sede), le mutazioni requireStaff con slugify
// server-side, guard is_sistema → 409, collisione slug 23505 → 409, scope RC2 di
// sede prima di ogni scrittura, degrado schema-assente (DB CI non migrato).
// =============================================================================

const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

const postBodySchema = z.object({
  nome: z.string({ error: 'nome è obbligatorio' }).min(1, 'nome è obbligatorio'),
  scuola_id: zScuolaId,
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  nome: z.unknown().optional(),
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
  attivo: z.unknown().optional(),
})

const deleteQuerySchema = z.object({ id: zUuid })

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

type CategoriaScope = { scuola_id: string | null; is_sistema: boolean }

// RC2 — legge la categoria per id e ne verifica lo SCOPE di sede prima di ogni
// mutazione. `requireStaff` verifica il RUOLO, non il TENANT, e la route gira in
// service-role (bypassa la RLS): senza questo, un admin potrebbe modificare/eliminare
// categorie di un'altra sede conoscendone l'UUID. Globale (scuola_id NULL) → gestibile
// da qualunque admin (sede unica; seed condiviso — annotato nel PRD).
async function caricaCategoriaConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ cat?: CategoriaScope; response?: NextResponse }> {
  const { data, error } = await supabase
    .from('news_categorie')
    .select('scuola_id, is_sistema')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('news', 'info', { operazione: 'news/categorie:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/categorie:scope', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nella lettura della categoria' }, { status: 500 }) }
  }
  if (!data) return { response: NextResponse.json({ error: 'Categoria non trovata' }, { status: 404 }) }
  const cat = data as CategoriaScope
  if (cat.scuola_id != null) {
    const sedi = await resolveScuoleAttive(request, supabase, user)
    if (!sedi.includes(cat.scuola_id)) {
      return { response: NextResponse.json({ error: 'Sede non accessibile' }, { status: 403 }) }
    }
  }
  return { cat }
}

// GET /api/news/categorie — globali (scuola_id NULL) + quelle delle sedi accessibili.
export const GET = withRoute('news/categorie:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase.from('news_categorie').select('*').order('ordine', { ascending: true })
    if (sedi.length > 0) query = query.or(`scuola_id.is.null,scuola_id.in.(${sedi.join(',')})`)
    else query = query.is('scuola_id', null)

    const { data, error } = await query
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/categorie:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, categorie: [] })
      }
      logErrore({ operazione: 'news/categorie:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle categorie' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, categorie: (data ?? []) as NewsCategoria[] })
  } catch (err) {
    logErrore({ operazione: 'news/categorie:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/news/categorie — crea una categoria personalizzata di sede.
export const POST = withRoute('news/categorie:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
    if (sw.response) return sw.response

    const record = {
      scuola_id: sw.scuolaId ?? null,
      nome: body.nome,
      slug: slugify(body.nome),
      colore: (body.colore as string | undefined) ?? null,
      icona: (body.icona as string | undefined) ?? null,
      ordine: (body.ordine as number | undefined) ?? 99,
      is_sistema: false,
      attivo: true,
    }
    const { data, error } = await supabase.from('news_categorie').insert(record).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/categorie:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Esiste già una categoria con questo nome' }, { status: 409 })
      }
      logErrore({ operazione: 'news/categorie:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella creazione della categoria' }, { status: 500 })
    }
    logEvento('news', 'info', { operazione: 'news/categorie:POST', esito: 'creata', categoria_id: (data as { id?: string } | null)?.id })
    return NextResponse.json({ disponibile: true, categoria: data as NewsCategoria }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'news/categorie:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/news/categorie — rinomina/colore/icona/ordine/attivo (vietato su is_sistema).
export const PATCH = withRoute('news/categorie:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data as Record<string, unknown>

    const updates: Record<string, unknown> = {}
    for (const f of ['nome', 'colore', 'icona', 'ordine', 'attivo']) if (body[f] !== undefined) updates[f] = body[f]
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // RC2 — scope di sede + guard is_sistema PRIMA di scrivere.
    const sc = await caricaCategoriaConScope(request, supabase, auth.user, b.data.id)
    if (sc.response) return sc.response
    if (sc.cat!.is_sistema) {
      return NextResponse.json({ error: 'Le categorie di sistema non si modificano' }, { status: 409 })
    }

    if (typeof updates.nome === 'string' && updates.nome.trim()) {
      updates.slug = slugify(updates.nome)
    }

    const { data, error } = await supabase.from('news_categorie').update(updates).eq('id', b.data.id).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/categorie:PATCH', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Esiste già una categoria con questo nome' }, { status: 409 })
      }
      logErrore({ operazione: 'news/categorie:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'aggiornamento della categoria' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, categoria: data as NewsCategoria })
  } catch (err) {
    logErrore({ operazione: 'news/categorie:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/news/categorie?id= — vietato su is_sistema (409).
export const DELETE = withRoute('news/categorie:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    const supabase = await createAdminClient()

    const sc = await caricaCategoriaConScope(request, supabase, auth.user, id)
    if (sc.response) return sc.response
    if (sc.cat!.is_sistema) {
      return NextResponse.json({ error: 'Le categorie di sistema non possono essere eliminate' }, { status: 409 })
    }

    const { error } = await supabase.from('news_categorie').delete().eq('id', id)
    if (error) {
      logErrore({ operazione: 'news/categorie:DELETE', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'eliminazione della categoria' }, { status: 500 })
    }
    logEvento('news', 'info', { operazione: 'news/categorie:DELETE', esito: 'eliminata' })
    return NextResponse.json({ disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'news/categorie:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
