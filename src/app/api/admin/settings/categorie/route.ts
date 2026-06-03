import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// GET /api/admin/settings/categorie?userId=&scuola_id=  (staff)
// Ritorna le categorie globali + quelle della scuola.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const scuolaId = searchParams.get('scuola_id') || auth.user.scuola_id

    const supabase = await createAdminClient()
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
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    if (!body.nome) return NextResponse.json({ error: 'nome è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const record = {
      scuola_id: body.scuola_id || auth.user.scuola_id || null,
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
    const body = await request.json()
    if (!body.id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const allowed = ['nome', 'colore', 'icona', 'ordine', 'attivo']
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('payment_categories').update(updates).eq('id', body.id).select().single()
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
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: cat } = await supabase.from('payment_categories').select('is_sistema').eq('id', id).single()
    if (cat?.is_sistema) {
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
