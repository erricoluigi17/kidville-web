import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// POST /api/parent/presenze/comunica-assenza?userId=
// body: { studentId, data, motivo? }
// Il genitore comunica IN ANTICIPO un'assenza (anche per date future). Crea/aggiorna
// la riga presenza come 'assente' già giustificata. Solo primaria.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { studentId, data, motivo } = await request.json()
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

    // Upsert: assenza già giustificata dal genitore (anche per date future).
    const { data: row, error } = await supabase
      .from('presenze')
      .upsert(
        {
          alunno_id: studentId,
          section_id: alunno.section_id,
          data,
          stato: 'assente',
          giustificata: true,
          giustificazione_testo: typeof motivo === 'string' ? motivo.trim() || null : null,
          giustificata_da: userId,
          giustificata_il: new Date().toISOString(),
        },
        { onConflict: 'alunno_id,data' }
      )
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: row }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
