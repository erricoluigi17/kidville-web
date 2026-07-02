import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { generaPagella } from '@/lib/primaria/pagella-store'

// POST /api/primaria/pagella/batch?userId=
// Genera e archivia in batch un PDF per OGNI alunno dello scrutinio (chiuso).
// La generazione è indipendente dalla pubblicazione ai genitori. Riservata alla
// dirigenza. body: { scrutinioId }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const { scrutinioId } = await request.json()
    if (!scrutinioId) return NextResponse.json({ error: 'scrutinioId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    const { data: scrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato !== 'chiuso') return NextResponse.json({ error: 'Generazione disponibile solo a scrutinio chiuso' }, { status: 409 })

    // Scoping di plesso per la dirigenza: batch solo su scrutini del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    const { data: alunni } = await supabase.from('alunni').select('id').eq('section_id', scrutinio.section_id)
    const alunniIds = (alunni ?? []).map((a) => a.id)

    let generate = 0
    const errori: { alunnoId: string; error: string }[] = []
    for (const alunnoId of alunniIds) {
      const { error } = await generaPagella(supabase, scrutinioId, alunnoId, auth.user.id, true)
      if (error) errori.push({ alunnoId, error })
      else generate++
    }

    return NextResponse.json({ success: true, generate, totale: alunniIds.length, errori })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
