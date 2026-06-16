import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'

// GET /api/parent/students?userId=  — lista degli alunni collegati al genitore.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

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
