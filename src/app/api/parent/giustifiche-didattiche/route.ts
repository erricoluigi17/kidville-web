import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// POST /api/parent/giustifiche-didattiche?userId=
// body: { studentId, data, motivo?, materiaId? }
// Il genitore dichiara l'alunno impreparato a priori. Solo primaria.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { studentId, data, motivo, materiaId } = await request.json()
    if (!studentId || !data) {
      return NextResponse.json({ error: 'studentId e data obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .single()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).single()
      schoolType = sez?.school_type ?? null
    }
    if (schoolType !== 'primaria') {
      return NextResponse.json({ error: 'Disponibile solo per la scuola primaria' }, { status: 403 })
    }

    const { data: inserted, error } = await supabase
      .from('giustifiche_didattiche')
      .insert({
        alunno_id: studentId,
        section_id: alunno.section_id,
        materia_id: materiaId ?? null,
        data,
        motivo: typeof motivo === 'string' ? motivo.trim() || null : null,
        origine: 'genitore',
        creato_da: userId,
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: inserted }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
