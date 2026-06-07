import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'

// GET /api/mensa/menu-config?scuola_id=  — tutti i menu della scuola
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const scuolaId = searchParams.get('scuola_id')
    if (!scuolaId) return NextResponse.json({ error: 'scuola_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .select('id, nome, ordine, created_at')
      .eq('scuola_id', scuolaId)
      .order('ordine', { ascending: true })
    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('GET /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/mensa/menu-config  { scuola_id, nome, ordine? }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const { scuola_id, nome, ordine = 0 } = body
    if (!scuola_id || !nome?.trim()) {
      return NextResponse.json({ error: 'scuola_id e nome sono obbligatori' }, { status: 400 })
    }
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .insert({ scuola_id, nome: nome.trim(), ordine })
      .select('id, nome, ordine')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('POST /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/mensa/menu-config  { id, nome?, ordine? }
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const { id, nome, ordine } = body
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const updates: Record<string, unknown> = {}
    if (nome !== undefined) updates.nome = nome.trim()
    if (ordine !== undefined) updates.ordine = ordine

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .update(updates)
      .eq('id', id)
      .select('id, nome, ordine')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('PATCH /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/menu-config?id=
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    // Blocca eliminazione se ci sono rotazioni/override collegati
    const [{ count: cRot }, { count: cOvr }] = await Promise.all([
      supabase.from('mensa_menu_rotazione').select('id', { count: 'exact', head: true }).eq('menu_config_id', id),
      supabase.from('mensa_menu_override').select('id', { count: 'exact', head: true }).eq('menu_config_id', id),
    ])
    if ((cRot ?? 0) > 0 || (cOvr ?? 0) > 0) {
      return NextResponse.json({ error: 'Impossibile eliminare: il menu ha voci di rotazione o override associati.' }, { status: 409 })
    }

    const { error } = await supabase.from('mensa_menu_config').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
