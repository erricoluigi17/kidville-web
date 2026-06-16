import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { sezioniDiUtentePerGrado } from '@/lib/sezioni/docenti'

// GET /api/primaria/classi?userId=
// Classi di scuola primaria assegnate al docente (hub "Le mie classi"),
// con conteggio alunni. Gating: il docente deve avere grado 'primaria'.
export async function GET(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const ctx = await loadGradoContext(userId)
    if (!ctx) return NextResponse.json({ error: 'Utente non trovato' }, { status: 401 })
    if (!ctx.gradi.includes('primaria')) {
      return NextResponse.json({ error: 'Docente non abilitato alla primaria' }, { status: 403 })
    }

    const supabase = await createAdminClient()
    const sezioni = await sezioniDiUtentePerGrado(supabase, userId, 'primaria')

    // Conteggio alunni per sezione (canonico: alunni.section_id).
    const data = await Promise.all(
      sezioni.map(async (s) => {
        const { count } = await supabase
          .from('alunni')
          .select('id', { count: 'exact', head: true })
          .eq('section_id', s.id)
        return { ...s, numAlunni: count ?? 0 }
      })
    )

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
