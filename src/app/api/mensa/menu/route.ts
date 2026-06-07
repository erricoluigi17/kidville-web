import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { loadMensaConfig, loadResolveOptions, resolveMenuConfigId, DEFAULT_SCUOLA } from '@/lib/mensa/server'
import { resolveMenuRange } from '@/lib/mensa/resolveMenu'

function scuolaIdFrom(request: Request, fallback?: string | null): string {
  const { searchParams } = new URL(request.url)
  return searchParams.get('scuola_id') || fallback || DEFAULT_SCUOLA
}

// GET /api/mensa/menu?userId=&from=&to=&scuola_id=&menu_config_id=&alunno_id=
//   risolve il menu per ogni data dell'intervallo (override -> rotazione).
//   Se alunno_id è passato, determina il menu dalla classe dell'alunno.
//   Se menu_config_id è passato, usa direttamente quel menu.
//   Se nessuno dei due è passato, usa il menu legacy (menu_config_id IS NULL).
//   Con ?raw=1 ritorna le tabelle grezze per l'editor admin → richiede staff.
export async function GET(request: Request) {
  try {
    const supabase = await createAdminClient()
    const { searchParams } = new URL(request.url)

    if (searchParams.get('raw') === '1') {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response
      const scuolaId = scuolaIdFrom(request, auth.user.scuola_id)
      const menuConfigId = searchParams.get('menu_config_id') || null
      let rotQ = supabase.from('mensa_menu_rotazione').select('*').eq('scuola_id', scuolaId).order('settimana').order('giorno_settimana')
      let ovrQ = supabase.from('mensa_menu_override').select('*').eq('scuola_id', scuolaId).order('data')
      if (menuConfigId) {
        rotQ = rotQ.eq('menu_config_id', menuConfigId)
        ovrQ = ovrQ.eq('menu_config_id', menuConfigId)
      } else {
        rotQ = rotQ.is('menu_config_id', null)
        ovrQ = ovrQ.is('menu_config_id', null)
      }
      const [{ data: rotazione }, { data: override }, config] = await Promise.all([rotQ, ovrQ, loadMensaConfig(supabase, scuolaId)])
      return NextResponse.json({ success: true, data: { rotazione: rotazione ?? [], override: override ?? [], config } })
    }

    const scuolaId = scuolaIdFrom(request)
    const today = new Date().toISOString().slice(0, 10)
    const from = searchParams.get('from') ?? today
    const to = searchParams.get('to') ?? from

    // Determina menu_config_id: esplicito → dall'alunno → null (legacy)
    let menuConfigId: string | null = searchParams.get('menu_config_id') || null
    if (!menuConfigId) {
      const alunnoId = searchParams.get('alunno_id')
      if (alunnoId) {
        const { data: al } = await supabase.from('alunni').select('classe_sezione, scuola_id').eq('id', alunnoId).maybeSingle()
        if (al) {
          menuConfigId = await resolveMenuConfigId(supabase, al.scuola_id ?? scuolaId, al.classe_sezione, from)
        }
      }
    }

    const options = await loadResolveOptions(supabase, scuolaId, undefined, menuConfigId)
    const giorni = resolveMenuRange(from, to, options)

    // Se il menu è stato risolto per un alunno, includi il nome del menu nella risposta
    let menuNome: string | null = null
    if (menuConfigId) {
      const { data: cfg } = await supabase.from('mensa_menu_config').select('nome').eq('id', menuConfigId).maybeSingle()
      menuNome = (cfg?.nome as string | null) ?? null
    }

    return NextResponse.json({ success: true, data: giorni, meta: { menuNome } })
  } catch (err) {
    console.error('Errore API GET mensa/menu:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PUT /api/mensa/menu  (staff) — upsert rotazione e/o override.
// Body: { userId, scuola_id?, menu_config_id?,
//         rotazione?: [{settimana, giorno_settimana, portate, note}],
//         override?: [{data, chiuso, portate, note}] }
export async function PUT(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const scuolaId = body.scuola_id || auth.user.scuola_id || DEFAULT_SCUOLA
    const menuConfigId: string | null = body.menu_config_id || null
    const supabase = await createAdminClient()

    if (Array.isArray(body.rotazione) && body.rotazione.length > 0) {
      const rows = body.rotazione.map((r: Record<string, unknown>) => ({
        scuola_id: scuolaId,
        menu_config_id: menuConfigId,
        settimana: r.settimana,
        giorno_settimana: r.giorno_settimana,
        portate: r.portate ?? {},
        ingredienti: r.ingredienti ?? {},
        allergeni: r.allergeni ?? {},
        note: r.note ?? null,
      }))
      // Usa il conflict target corretto a seconda del tipo di menu
      const rotConflict = menuConfigId
        ? 'scuola_id,menu_config_id,settimana,giorno_settimana'
        : 'scuola_id,settimana,giorno_settimana'
      const { error } = await supabase.from('mensa_menu_rotazione').upsert(rows, { onConflict: rotConflict })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (Array.isArray(body.override) && body.override.length > 0) {
      const rows = body.override.map((o: Record<string, unknown>) => ({
        scuola_id: scuolaId,
        menu_config_id: menuConfigId,
        data: o.data,
        chiuso: o.chiuso ?? false,
        portate: o.portate ?? {},
        ingredienti: o.ingredienti ?? {},
        allergeni: o.allergeni ?? {},
        note: o.note ?? null,
      }))
      const ovrConflict = menuConfigId ? 'scuola_id,menu_config_id,data' : 'scuola_id,data'
      const { error } = await supabase.from('mensa_menu_override').upsert(rows, { onConflict: ovrConflict })
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
