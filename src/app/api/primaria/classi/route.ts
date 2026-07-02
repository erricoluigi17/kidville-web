import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { sezioniDiUtentePerGrado, type SezioneInfo } from '@/lib/sezioni/docenti'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (requireDocente), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/primaria/classi?userId=
// Classi di scuola primaria visibili all'utente (hub "Le mie classi").
//  - educator: solo le sezioni assegnate (deve avere grado 'primaria').
//  - admin/coordinator/segreteria: TUTTE le classi primaria dei propri plessi.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()

    let sezioni: SezioneInfo[] = []
    if (user.role === 'educator') {
      const ctx = await loadGradoContext(user.id)
      if (!ctx || !ctx.gradi.includes('primaria')) {
        return NextResponse.json({ error: 'Docente non abilitato alla primaria' }, { status: 403 })
      }
      sezioni = await sezioniDiUtentePerGrado(supabase, user.id, 'primaria')
    } else {
      // Staff/segreteria: tutte le sezioni primaria dei plessi consentiti (no cross-tenant).
      const plessi = await scuoleDiUtente(supabase, user)
      if (plessi.length) {
        const { data } = await supabase
          .from('sections')
          .select('id, name, school_type')
          .eq('school_type', 'primaria')
          .in('scuola_id', plessi)
          .order('name')
        sezioni = (data ?? []) as SezioneInfo[]
      }
    }

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
