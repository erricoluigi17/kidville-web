import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { loadGradoContext } from '@/lib/auth/require-grado'
import { materieDiDocenteInSezione } from '@/lib/sezioni/docenti'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `sectionId` (param dinamico) è usato come UUID nelle query (sections.id,
// alunni.section_id, materie.section_id) → zUuid. `userId` in query è
// consumato dal gate identità (requireDocente), non dall'handler.

// GET /api/primaria/classe/[sectionId]?userId=
// Bundle di contesto classe: dati sezione, alunni, materie.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  try {
    const { sectionId: rawSectionId } = await params

    // 1) Gate ruolo (educator/admin/coordinator/segreteria; genitore escluso).
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const secParsed = parseData(zUuid, rawSectionId)
    if ('response' in secParsed) return secParsed.response
    const sectionId = secParsed.data

    const supabase = await createAdminClient()

    // 2) Scope per plesso/classe (educator: solo sezioni assegnate; staff/segreteria: tutto il plesso).
    const scopeErr = await assertSezioneInScope(supabase, user, sectionId)
    if (scopeErr) return scopeErr

    // 3) Abilitazione al grado primaria: solo per il docente puro
    //    (admin/coordinator/segreteria bypassano — agiscono su tutta la scuola).
    if (user.role === 'educator') {
      const ctx = await loadGradoContext(user.id)
      if (!ctx || !ctx.gradi.includes('primaria')) {
        return NextResponse.json({ error: 'Docente non abilitato alla primaria' }, { status: 403 })
      }
    }

    const [{ data: section }, { data: alunni }] = await Promise.all([
      supabase.from('sections').select('id, name, school_type, scuola_id').eq('id', sectionId).maybeSingle(),
      // Alunni attivi della sezione (fonte unica: alunni.section_id, sincronizzato dal trigger).
      supabase.from('alunni').select('id, nome, cognome, allergies, allergeni').eq('section_id', sectionId).eq('stato', 'iscritto').order('cognome'),
    ])
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    // Materie: il docente vede SOLO le proprie (contitolarità/isolamento disciplina);
    // staff/segreteria operano sull'intera classe → tutte le materie attive della sezione.
    let materie: unknown[] = []
    if (user.role === 'educator') {
      const materieIds = await materieDiDocenteInSezione(supabase, user.id, sectionId)
      if (materieIds.length) {
        const { data } = await supabase
          .from('materie')
          .select('id, nome, codice, e_civica, turno_mensa')
          .in('id', materieIds)
          .eq('attiva', true)
          .order('ordine')
        materie = data ?? []
      }
    } else {
      const { data } = await supabase
        .from('materie')
        .select('id, nome, codice, e_civica, turno_mensa')
        .eq('section_id', sectionId)
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
