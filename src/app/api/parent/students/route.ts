import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (requireUser), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/parent/students?userId=  — lista degli alunni collegati al genitore.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // Unione runtime (legame_genitori_alunni) + anagrafica (student_parents via
    // parents.auth_user_id): risolve i figli anche se il legame è presente in una
    // sola delle due tabelle (fix contesto figlio per mensa/chat/pagamenti).
    const ids = await getFigliDiGenitore(supabase, auth.user.id)
    if (ids.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id')
      .in('id', ids)

    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('GET /api/parent/students:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
