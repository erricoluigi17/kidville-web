import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { CassaCategoria } from '@/lib/cassa/tipi'

// Codici PostgREST/Postgres «schema cassa assente» (DB E2E CI non migrato). Copia
// locale della lista canonica di `@/lib/cassa/saldo`: tiene questa route — e i suoi
// test — indipendenti dal join con gli altri esecutori. Stessa semantica.
const CASSA_SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])
function schemaAssente(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code
  return !!code && CASSA_SCHEMA_ASSENTE.has(code)
}

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

/**
 * RC2 — legge la categoria per id e ne verifica lo SCOPE di sede prima di ogni
 * mutazione (PATCH/DELETE). `requireStaff` verifica il RUOLO, non il TENANT, e la
 * route gira in service-role (bypassa la RLS): senza questo, un admin potrebbe
 * modificare/eliminare categorie di un'altra sede conoscendone l'UUID.
 *
 * - categoria DI SEDE (`scuola_id` non-NULL): consentita solo se la sede è fra le
 *   accessibili (`resolveScuoleAttive`) → altrimenti 403;
 * - categoria GLOBALE (`scuola_id` NULL): gestibile da qualunque admin (sede reale
 *   unica; seed condiviso). In multi-sede andrà rivista (annotato nel PRD).
 *
 * Ritorna la riga oppure una NextResponse 4xx/5xx pronta.
 */
async function caricaCategoriaConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ cat?: CategoriaScope; response?: NextResponse }> {
  const { data, error } = await supabase
    .from('cassa_categorie')
    .select('scuola_id, is_sistema')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('cassa', 'info', { operazione: 'categorie:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'pagamenti/cassa/categorie:scope', stato: 500, evento: 'db' }, error)
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

// GET /api/pagamenti/cassa/categorie?scuola_id=  (staff — serve al form uscita)
// Ritorna le categorie globali (scuola_id NULL) + quelle della sede.
export const GET = withRoute('pagamenti/cassa/categorie:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId

    let query = supabase.from('cassa_categorie').select('*').order('ordine', { ascending: true })
    if (scuolaId) query = query.or(`scuola_id.is.null,scuola_id.eq.${scuolaId}`)
    else query = query.is('scuola_id', null)

    const { data, error } = await query
    if (error) {
      if (schemaAssente(error)) {
        logEvento('cassa', 'info', { operazione: 'categorie:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, categorie: [] })
      }
      logErrore({ operazione: 'pagamenti/cassa/categorie:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle categorie' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, categorie: (data ?? []) as CassaCategoria[] })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/categorie:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/cassa/categorie  (solo admin) — crea categoria personalizzata
export const POST = withRoute('pagamenti/cassa/categorie:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
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
    const { data, error } = await supabase.from('cassa_categorie').insert(record).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('cassa', 'info', { operazione: 'categorie:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'pagamenti/cassa/categorie:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella creazione della categoria' }, { status: 500 })
    }
    logEvento('cassa', 'info', {
      operazione: 'categorie:POST',
      esito: 'creata',
      categoria_id: (data as { id?: string } | null)?.id,
      scuola_id: sw.scuolaId ?? null,
    })
    return NextResponse.json({ disponibile: true, categoria: data as CassaCategoria }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/categorie:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/pagamenti/cassa/categorie  (solo admin) — rinomina/colore/icona/ordine/attivo
export const PATCH = withRoute('pagamenti/cassa/categorie:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data as Record<string, unknown>

    const allowed = ['nome', 'colore', 'icona', 'ordine', 'attivo']
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]
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

    // Rinomina → rigenera lo slug server-side (stessa `slugify` del POST): senza,
    // lo slug resterebbe quello vecchio, disallineato dal nome mostrato.
    if (typeof updates.nome === 'string' && updates.nome.trim()) {
      updates.slug = slugify(updates.nome)
    }

    const { data, error } = await supabase.from('cassa_categorie').update(updates).eq('id', b.data.id).select().single()
    if (error) {
      if (schemaAssente(error)) {
        logEvento('cassa', 'info', { operazione: 'categorie:PATCH', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      // Violazione unique sullo slug (rinomina che collide con una categoria esistente).
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'Esiste già una categoria con questo nome' }, { status: 409 })
      }
      logErrore({ operazione: 'pagamenti/cassa/categorie:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'aggiornamento della categoria' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, categoria: data as CassaCategoria })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/categorie:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/cassa/categorie?id=  (solo admin) — vietato su is_sistema (409)
export const DELETE = withRoute('pagamenti/cassa/categorie:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    const supabase = await createAdminClient()

    // RC2 — scope di sede + guard is_sistema PRIMA di eliminare.
    const sc = await caricaCategoriaConScope(request, supabase, auth.user, id)
    if (sc.response) return sc.response
    if (sc.cat!.is_sistema) {
      return NextResponse.json({ error: 'Le categorie di sistema non possono essere eliminate' }, { status: 409 })
    }

    const { error } = await supabase.from('cassa_categorie').delete().eq('id', id)
    if (error) {
      logErrore({ operazione: 'pagamenti/cassa/categorie:DELETE', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'eliminazione della categoria' }, { status: 500 })
    }
    logEvento('cassa', 'info', { operazione: 'categorie:DELETE', esito: 'eliminata' })
    return NextResponse.json({ disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/categorie:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
