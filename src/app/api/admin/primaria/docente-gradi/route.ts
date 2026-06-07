import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

const GRADI_VALIDI = ['nido', 'infanzia', 'primaria'] as const

// GET /api/admin/primaria/docente-gradi?scuolaId=
// Elenco docenti/staff con i loro gradi (per la gestione classificazione).
export async function GET(request: NextRequest) {
  try {
    const scuolaId = new URL(request.url).searchParams.get('scuolaId')
    const supabase = await createAdminClient()
    let query = supabase
      .from('utenti')
      .select('id, nome, cognome, email, ruolo, role, gradi')
      .in('ruolo', ['maestra', 'educator', 'docente', 'coordinator', 'admin'])
      .order('cognome', { ascending: true })
    if (scuolaId) query = query.eq('scuola_id', scuolaId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/primaria/docente-gradi  body: { utenteId, gradi: string[] }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { utenteId, gradi } = await request.json()
    if (!utenteId || !Array.isArray(gradi)) {
      return NextResponse.json({ error: 'utenteId e gradi[] obbligatori' }, { status: 400 })
    }
    const invalid = gradi.filter((g: string) => !GRADI_VALIDI.includes(g as typeof GRADI_VALIDI[number]))
    if (invalid.length) {
      return NextResponse.json({ error: `Gradi non validi: ${invalid.join(', ')}` }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('utenti')
      .update({ gradi })
      .eq('id', utenteId)
      .select('id, nome, cognome, gradi')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
