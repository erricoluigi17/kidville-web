import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'

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
    const { data, error } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id, alunni(id, nome, cognome, classe_sezione, scuola_id)')
      .eq('genitore_id', auth.user.id)

    if (error) throw error
    const students = (data ?? []).map((r: Record<string, unknown>) => r.alunni).filter(Boolean)
    return NextResponse.json({ success: true, data: students })
  } catch (err) {
    console.error('GET /api/parent/students:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
