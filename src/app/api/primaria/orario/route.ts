import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/primaria/orario?sectionId=&userId=
// Orario settimanale in SOLA LETTURA (docente/genitore): campanelle + griglia.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    const [{ data: campanelle }, { data: orario }] = await Promise.all([
      supabase.from('campanelle').select('*').eq('section_id', sectionId).order('giorno_settimana').order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('id, giorno_settimana, campanella_id, materia_id, docente_id, note, materie(nome, codice), utenti(nome, cognome)')
        .eq('section_id', sectionId),
    ])

    return NextResponse.json({ success: true, data: { campanelle: campanelle ?? [], orario: orario ?? [] } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
