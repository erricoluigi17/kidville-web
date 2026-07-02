import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'

// POST /api/primaria/scrutinio/pubblica?userId=
// L'OK del dirigente: rende visibili ai genitori i voti/pagelle di uno scrutinio
// CHIUSO. La generazione dei PDF è separata (vedi /pagella/batch): si può
// generare/anteprima senza pubblicare. Riservata alla dirigenza.
// body: { scrutinioId, pubblicato: boolean }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const { scrutinioId, pubblicato } = await request.json()
    if (!scrutinioId || typeof pubblicato !== 'boolean') {
      return NextResponse.json({ error: 'scrutinioId e pubblicato (boolean) obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    const { data: scrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato, pubblicato')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato !== 'chiuso') return NextResponse.json({ error: 'Pubblicabile solo a scrutinio chiuso' }, { status: 409 })

    // Scoping di plesso per la dirigenza: si pubblicano solo scrutini del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    const { data: updated, error } = await supabase
      .from('scrutini')
      .update({
        pubblicato,
        pubblicato_da: pubblicato ? auth.user.id : null,
        pubblicato_il: pubblicato ? new Date().toISOString() : null,
      })
      .eq('id', scrutinioId)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Notifica genitori solo al passaggio a pubblicato=true (best-effort).
    if (pubblicato && !scrutinio.pubblicato) {
      try {
        const { data: alunni } = await supabase.from('alunni').select('id').eq('section_id', scrutinio.section_id)
        const alunniIds = (alunni ?? []).map((a) => a.id)
        if (alunniIds.length > 0) {
          await enqueueNotifichePerAlunni(supabase, {
            alunnoIds: alunniIds,
            tipo: 'pagella',
            titolo: 'Pagella disponibile',
            corpo: 'Il documento di valutazione è disponibile nell’area riservata.',
            link: '/parent/primaria/pagelle',
            entitaTipo: 'scrutinio',
            entitaId: scrutinioId,
          })
        }
      } catch { /* non bloccare */ }
    }

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
