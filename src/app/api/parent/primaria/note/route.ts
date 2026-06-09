import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/note?studentId=&userId=
// Note disciplinari/didattiche del figlio. Filtrate per oscuramento.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const studentId = sp.get('studentId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: note } = await supabase
      .from('note_disciplinari')
      .select('id, categoria, testo, richiede_firma, firmata_il, creato_il')
      .eq('alunno_id', studentId)
      .order('creato_il', { ascending: false })

    return NextResponse.json({ success: true, data: note ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/parent/primaria/note — firma presa visione
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    const body = await request.json()
    const { notaId } = body
    if (!notaId) return NextResponse.json({ error: 'notaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase
      .from('note_disciplinari')
      .update({ firmata_il: new Date().toISOString() })
      .eq('id', notaId)
      .is('firmata_il', null)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
