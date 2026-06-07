import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'

// GET /api/mensa/class-assignments?scuola_id=
// Ritorna tutte le assegnazioni (incluse quelle future), ordinate per classe + data.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const scuolaId = searchParams.get('scuola_id')
    if (!scuolaId) return NextResponse.json({ error: 'scuola_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .select('id, classe, menu_config_id, attivo_dal, created_at, mensa_menu_config(nome)')
      .eq('scuola_id', scuolaId)
      .order('classe', { ascending: true })
      .order('attivo_dal', { ascending: false })
    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('GET /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/mensa/class-assignments  { scuola_id, classe, menu_config_id, attivo_dal }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const { scuola_id, classe, menu_config_id, attivo_dal } = body
    if (!scuola_id || !classe?.trim() || !menu_config_id || !attivo_dal) {
      return NextResponse.json({ error: 'scuola_id, classe, menu_config_id e attivo_dal sono obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .insert({ scuola_id, classe: classe.trim(), menu_config_id, attivo_dal })
      .select('id, classe, menu_config_id, attivo_dal')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('POST /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/class-assignments?id=
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase.from('mensa_class_menu_assignment').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
