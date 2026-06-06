import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { loadMensaConfig, loadResolveOptions, DEFAULT_SCUOLA } from '@/lib/mensa/server'
import { resolveMenuRange } from '@/lib/mensa/resolveMenu'

function scuolaIdFrom(request: Request, fallback?: string | null): string {
  const { searchParams } = new URL(request.url)
  return searchParams.get('scuola_id') || fallback || DEFAULT_SCUOLA
}

// GET /api/mensa/menu?userId=&from=&to=&scuola_id=
//   risolve il menu per ogni data dell'intervallo (override -> rotazione).
//   Lettura del menu pubblica (info non personale, mostrata anche nel diario
//   maestro e ai genitori). Con ?raw=1 ritorna le tabelle grezze per l'editor
//   admin → in quel caso è richiesto lo staff.
export async function GET(request: Request) {
  try {
    const supabase = await createAdminClient()
    const { searchParams } = new URL(request.url)

    if (searchParams.get('raw') === '1') {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response
      const scuolaId = scuolaIdFrom(request, auth.user.scuola_id)
      const [{ data: rotazione }, { data: override }, config] = await Promise.all([
        supabase.from('mensa_menu_rotazione').select('*').eq('scuola_id', scuolaId).order('settimana').order('giorno_settimana'),
        supabase.from('mensa_menu_override').select('*').eq('scuola_id', scuolaId).order('data'),
        loadMensaConfig(supabase, scuolaId),
      ])
      return NextResponse.json({ success: true, data: { rotazione: rotazione ?? [], override: override ?? [], config } })
    }

    const scuolaId = scuolaIdFrom(request)
    const today = new Date().toISOString().slice(0, 10)
    const from = searchParams.get('from') ?? today
    const to = searchParams.get('to') ?? from
    const options = await loadResolveOptions(supabase, scuolaId)
    const giorni = resolveMenuRange(from, to, options)
    return NextResponse.json({ success: true, data: giorni })
  } catch (err) {
    console.error('Errore API GET mensa/menu:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PUT /api/mensa/menu  (staff) — upsert rotazione e/o override.
// Body: { userId, scuola_id?, rotazione?: [{settimana, giorno_settimana, portate, note}],
//         override?: [{data, chiuso, portate, note}] }
export async function PUT(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const scuolaId = body.scuola_id || auth.user.scuola_id || DEFAULT_SCUOLA
    const supabase = await createAdminClient()

    if (Array.isArray(body.rotazione) && body.rotazione.length > 0) {
      const rows = body.rotazione.map((r: Record<string, unknown>) => ({
        scuola_id: scuolaId,
        settimana: r.settimana,
        giorno_settimana: r.giorno_settimana,
        portate: r.portate ?? {},
        ingredienti: r.ingredienti ?? {},
        allergeni: r.allergeni ?? {},
        note: r.note ?? null,
      }))
      const { error } = await supabase.from('mensa_menu_rotazione').upsert(rows, { onConflict: 'scuola_id,settimana,giorno_settimana' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (Array.isArray(body.override) && body.override.length > 0) {
      const rows = body.override.map((o: Record<string, unknown>) => ({
        scuola_id: scuolaId,
        data: o.data,
        chiuso: o.chiuso ?? false,
        portate: o.portate ?? {},
        ingredienti: o.ingredienti ?? {},
        allergeni: o.allergeni ?? {},
        note: o.note ?? null,
      }))
      const { error } = await supabase.from('mensa_menu_override').upsert(rows, { onConflict: 'scuola_id,data' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API PUT mensa/menu:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/menu?userId=&override_id=  (staff) — rimuove un override.
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const overrideId = searchParams.get('override_id')
    if (!overrideId) return NextResponse.json({ error: 'override_id obbligatorio' }, { status: 400 })
    const supabase = await createAdminClient()
    const { error } = await supabase.from('mensa_menu_override').delete().eq('id', overrideId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE mensa/menu:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
