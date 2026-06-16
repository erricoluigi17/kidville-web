import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'

// GET /api/notifiche?userId=&solo_non_lette=  — notifiche dell'utente corrente
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const soloNonLette = searchParams.get('solo_non_lette') === 'true'

    const supabase = await createAdminClient()
    let query = supabase
      .from('notifiche')
      .select('id, tipo, titolo, corpo, link, entita_tipo, entita_id, letta_il, creato_il')
      .eq('utente_id', auth.user.id)
      .order('creato_il', { ascending: false })
      .limit(100)
    if (soloNonLette) query = query.is('letta_il', null)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const nonLette = (data || []).filter((n) => !n.letta_il).length
    return NextResponse.json({ success: true, data, non_lette: nonLette })
  } catch (err) {
    console.error('Errore API GET notifiche:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/notifiche  — segna letta una notifica (o tutte)
// Body: { userId, id? }  (senza id = segna tutte come lette)
export async function PATCH(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const body = await request.json().catch(() => ({}))

    const supabase = await createAdminClient()
    let q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('utente_id', auth.user.id).is('letta_il', null)
    if (body.id) q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('id', body.id).eq('utente_id', auth.user.id)
    const { error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API PATCH notifiche:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
