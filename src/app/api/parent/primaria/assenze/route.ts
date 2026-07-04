import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi produce lista vuota
// dalla query su `presenze` — stesso criterio di parent/competenze.
// `limit`: parseInt storico preservato nell'handler (default 60, nessun clamp):
// NON zPaginazione, che cambierebbe default e limiti.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  limit: z.string().optional(),
})

// GET /api/parent/primaria/assenze?studentId=&userId=&limit=30
// Cronologia presenze (assenze, ritardi, uscite anticipate) del figlio.
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data
    const limit = parseInt(q.data.limit ?? '60', 10)

    const supabase = await createAdminClient()
    const { data: presenze } = await supabase
      .from('presenze')
      .select('id, data, stato, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giustificata_il, note_appello')
      .eq('alunno_id', studentId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
      .order('data', { ascending: false })
      .limit(limit)

    return NextResponse.json({ success: true, data: presenze ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
