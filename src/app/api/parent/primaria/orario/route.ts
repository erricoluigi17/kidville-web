import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/orario?studentId=&userId=
// Orario settimanale (campanelle + griglia) della sezione del figlio, in SOLA
// LETTURA per la famiglia. Ricalca la lettura docente (/api/primaria/orario).
export async function GET(request: NextRequest) {
  try {
    const studentId = new URL(request.url).searchParams.get('studentId')
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .single()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    if (!alunno.section_id) {
      return NextResponse.json({ success: true, data: { campanelle: [], orario: [] } })
    }

    const [{ data: campanelle }, { data: orario }] = await Promise.all([
      supabase.from('campanelle').select('*').eq('section_id', alunno.section_id).order('giorno_settimana').order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('id, giorno_settimana, campanella_id, materia_id, docente_id, note, materie(nome, codice), utenti(nome, cognome)')
        .eq('section_id', alunno.section_id),
    ])

    return NextResponse.json({ success: true, data: { campanelle: campanelle ?? [], orario: orario ?? [] } })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
