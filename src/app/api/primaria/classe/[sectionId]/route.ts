import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId, loadAppUser } from '@/lib/auth/require-staff'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { sezioniDiUtente, materieDiDocenteInSezione } from '@/lib/sezioni/docenti'

// GET /api/primaria/classe/[sectionId]?userId=
// Bundle di contesto classe: dati sezione, alunni, materie del docente in classe.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  try {
    const { sectionId } = await params
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const ctx = await loadGradoContext(userId)
    if (!ctx || !ctx.gradi.includes('primaria')) {
      return NextResponse.json({ error: 'Docente non abilitato alla primaria' }, { status: 403 })
    }

    const supabase = await createAdminClient()

    // Admin/coordinator bypass: possono accedere a qualsiasi sezione.
    const appUser = await loadAppUser(userId)
    const isStaff = appUser?.role === 'admin' || appUser?.role === 'coordinator'

    if (!isStaff) {
      const mieSezioni = await sezioniDiUtente(supabase, userId)
      if (!mieSezioni.includes(sectionId)) {
        return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
      }
    }

    const [{ data: section }, { data: alunni }, materieIds] = await Promise.all([
      supabase.from('sections').select('id, name, school_type, scuola_id').eq('id', sectionId).single(),
      // Alunni attivi della sezione (fonte unica: alunni.section_id, sincronizzato dal trigger).
      supabase.from('alunni').select('id, nome, cognome, allergies, allergeni').eq('section_id', sectionId).eq('stato', 'iscritto').order('cognome'),
      materieDiDocenteInSezione(supabase, userId, sectionId),
    ])

    let materie: unknown[] = []
    if (materieIds.length) {
      const { data } = await supabase
        .from('materie')
        .select('id, nome, codice, e_civica, turno_mensa')
        .in('id', materieIds)
        .eq('attiva', true)
        .order('ordine')
      materie = data ?? []
    }

    return NextResponse.json({
      success: true,
      data: { section, alunni: alunni ?? [], materie },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
