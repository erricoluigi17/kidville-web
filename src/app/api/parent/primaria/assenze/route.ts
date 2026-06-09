import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/assenze?studentId=&userId=&limit=30
// Cronologia presenze (assenze, ritardi, uscite anticipate) del figlio.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const studentId = sp.get('studentId')
    const userId = getRequestUserId(request)
    const limit = parseInt(sp.get('limit') ?? '60', 10)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

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
