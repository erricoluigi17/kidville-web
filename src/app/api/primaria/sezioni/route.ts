import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/primaria/sezioni?userId=
// Elenco di tutte le sezioni di scuola primaria della scuola, usato per la
// "firma in un'altra classe" (supplenza): il docente può firmare ovunque.
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('sections')
      .select('id, name, scuola_id')
      .eq('school_type', 'primaria')
      .order('name')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
