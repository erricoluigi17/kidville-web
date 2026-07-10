import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` resta stringa permissiva (oggi il DB accetta anche formati non YYYY-MM-DD);
// `motivo` permissivo: oggi qualunque tipo è accettato (i non-string diventano null).
const postBodySchema = z.object({
  studentId: zUuid,
  data: z.string().min(1),
  motivo: z.unknown().optional(),
})

// POST /api/parent/presenze/comunica-assenza?userId=
// body: { studentId, data, motivo? }
// Il genitore comunica IN ANTICIPO un'assenza (anche per date future). Crea/aggiorna
// la riga presenza come 'assente' già giustificata. Solo primaria.
export async function POST(request: NextRequest) {
  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { studentId, data, motivo } = b.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).maybeSingle()
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
