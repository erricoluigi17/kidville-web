import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// POST /api/parent/presenze/giustifica?userId=
// body: { studentId, data, motivo }
// Il genitore giustifica un'assenza/ritardo/uscita del figlio. Solo primaria.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { studentId, data, motivo } = await request.json()
    if (!studentId || !data) {
      return NextResponse.json({ error: 'studentId e data obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Gating primaria: la giustifica genitore è ammessa solo per la scuola primaria.
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
      return NextResponse.json({ error: 'Giustifica disponibile solo per la scuola primaria' }, { status: 403 })
    }

    // Aggiorna la riga presenza del giorno (deve esistere: appello registrato dal docente).
    const { data: updated, error } = await supabase
      .from('presenze')
      .update({
        giustificata: true,
        giustificazione_testo: typeof motivo === 'string' ? motivo.trim() || null : null,
        giustificata_da: userId,
        giustificata_il: new Date().toISOString(),
        // Una nuova giustifica azzera l'eventuale presa visione precedente.
        giust_vista_il: null,
        giust_vista_da: null,
      })
      .eq('alunno_id', studentId)
      .eq('data', data)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Nessuna assenza registrata per quella data' }, { status: 404 })

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
