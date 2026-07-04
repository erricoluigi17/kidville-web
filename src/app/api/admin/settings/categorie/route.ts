import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) → "non fornito",
 * così il codice applica il fallback storico (`|| auth.user.scuola_id ...`).
 * Validarlo come uuid chiude anche l'interpolazione nel filtro PostgREST `.or()`.
 */
const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

// slug/colore/icona/ordine: oggi pass-through senza vincoli (tipi enforced dal
// DB): schema volutamente permissivo. L'.optional() su z.unknown() è
// OBBLIGATORIO (in zod v4 z.unknown() nudo è required a runtime).
const postBodySchema = z.object({
  nome: z.string({ error: 'nome è obbligatorio' }).min(1, 'nome è obbligatorio'),
  scuola_id: zScuolaId,
  slug: z.unknown().optional(),
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
})

const patchBodySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale 'id è obbligatorio'
  nome: z.unknown().optional(),
  colore: z.unknown().optional(),
  icona: z.unknown().optional(),
  ordine: z.unknown().optional(),
  attivo: z.unknown().optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale 'id è obbligatorio'
})

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// GET /api/admin/settings/categorie?userId=&scuola_id=  (staff)
// Ritorna le categorie globali + quelle della scuola.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // Sede risolta server-side: lo scuola_id del client è SOLO una preferenza,
    // validata contro i plessi accessibili (mai fidarsi del client).
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId

    let query = supabase.from('payment_categories').select('*').order('ordine', { ascending: true })
    // globali (scuola_id NULL) + della scuola
    if (scuolaId) query = query.or(`scuola_id.is.null,scuola_id.eq.${scuolaId}`)
    else query = query.is('scuola_id', null)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API GET categorie:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/admin/settings/categorie  (staff) — crea categoria personalizzata
// Body: { userId, nome, scuola_id?, colore?, icona?, ordine? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    // Sede derivata server-side: mai usare lo scuola_id del body per la scrittura.
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
    if (sw.response) return sw.response

    const record = {
      scuola_id: sw.scuolaId ?? null,
      nome: body.nome,
      slug: body.slug || slugify(body.nome),
      colore: body.colore ?? '#006A5F',
      icona: body.icona ?? '💶',
      is_sistema: false,
      ordine: body.ordine ?? 99,
    }
    const { data, error } = await supabase.from('payment_categories').insert(record).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST categorie:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/settings/categorie  (staff) — rinomina/colore/icona/ordine/attivo
// Body: { userId, id, nome?, colore?, icona?, ordine?, attivo? }
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
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
    const { data, error } = await supabase.from('payment_categories').update(updates).eq('id', b.data.id).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH categorie:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/admin/settings/categorie?id=xxx&userId=yyy  (staff)
// Bloccato per le categorie di sistema (is_sistema=true).
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    const supabase = await createAdminClient()
    const { data: cat } = await supabase.from('payment_categories').select('is_sistema').eq('id', id).maybeSingle()
    if (!cat) return NextResponse.json({ error: 'Categoria non trovata' }, { status: 404 })
    if (cat.is_sistema) {
      return NextResponse.json({ error: 'Le categorie di sistema non possono essere eliminate' }, { status: 403 })
    }
    const { error } = await supabase.from('payment_categories').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE categorie:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
