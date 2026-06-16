import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// GET /api/admin/primaria/scrutinio-periodi?annoScolastico=&userId=
// Elenca i periodi di scrutinio configurati per la scuola dello staff.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    if (!auth.user.scuola_id) return NextResponse.json({ error: 'Scuola non associata' }, { status: 400 })

    const anno = new URL(request.url).searchParams.get('annoScolastico')

    const supabase = await createAdminClient()
    let query = supabase
      .from('scrutinio_periodi')
      .select('*')
      .eq('scuola_id', auth.user.scuola_id)
      .order('ordine')
    if (anno) query = query.eq('anno_scolastico', anno)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/scrutinio-periodi?userId=
// body: { annoScolastico, nome, ordine?, dataInizio?, dataFine? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    if (!auth.user.scuola_id) return NextResponse.json({ error: 'Scuola non associata' }, { status: 400 })

    const { annoScolastico, nome, ordine, dataInizio, dataFine } = await request.json()
    if (!annoScolastico || !nome) {
      return NextResponse.json({ error: 'annoScolastico e nome obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .insert({
        scuola_id: auth.user.scuola_id,
        anno_scolastico: annoScolastico,
        nome,
        ordine: ordine ?? 0,
        data_inizio: dataInizio ?? null,
        data_fine: dataFine ?? null,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/primaria/scrutinio-periodi?userId=
// body: { id, nome?, ordine?, dataInizio?, dataFine?, attivo? }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { id, nome, ordine, dataInizio, dataFine, attivo } = await request.json()
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })

    const patch: Record<string, unknown> = {}
    if (nome !== undefined) patch.nome = nome
    if (ordine !== undefined) patch.ordine = ordine
    if (dataInizio !== undefined) patch.data_inizio = dataInizio
    if (dataFine !== undefined) patch.data_fine = dataFine
    if (attivo !== undefined) patch.attivo = attivo

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('scrutinio_periodi')
      .update(patch)
      .eq('id', id)
      .eq('scuola_id', auth.user.scuola_id ?? '')
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/admin/primaria/scrutinio-periodi?id=&userId=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase
      .from('scrutinio_periodi')
      .delete()
      .eq('id', id)
      .eq('scuola_id', auth.user.scuola_id ?? '')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
