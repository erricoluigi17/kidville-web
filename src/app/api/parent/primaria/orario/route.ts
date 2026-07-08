import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi degrada a 404 dalla
// query su `alunni` — stesso criterio di parent/competenze (e fixture test 'a-1').
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// GET /api/parent/primaria/orario?studentId=&userId=
// Orario settimanale (campanelle + griglia) della sezione del figlio, in SOLA
// LETTURA per la famiglia. Ricalca la lettura docente (/api/primaria/orario).
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .maybeSingle()
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
