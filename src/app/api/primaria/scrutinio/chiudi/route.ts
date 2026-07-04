import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  scrutinioId: zUuid,
})

// POST /api/primaria/scrutinio/chiudi?userId=
// Chiusura della sessione di scrutinio. Riservata alla dirigenza (admin/coordinator).
// Valida la completezza (ogni alunno ha un giudizio per ogni disciplina + comportamento),
// blocca lo scrutinio e notifica i genitori della disponibilità della pagella.
// body: { scrutinioId }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId } = b.data

    const supabase = await createAdminClient()

    const { data: scrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, periodo_id, stato')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato === 'chiuso') return NextResponse.json({ error: 'Scrutinio già chiuso' }, { status: 409 })

    // Scoping di plesso per la dirigenza: si chiudono solo scrutini del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    const [{ data: alunni }, { data: materie }, { data: giudizi }, { data: comportamento }] = await Promise.all([
      supabase.from('alunni').select('id').eq('section_id', scrutinio.section_id),
      supabase.from('materie').select('id').eq('section_id', scrutinio.section_id).eq('attiva', true),
      supabase.from('scrutinio_giudizi').select('alunno_id, materia_id, giudizio_sintetico').eq('scrutinio_id', scrutinioId),
      supabase.from('scrutinio_comportamento').select('alunno_id, giudizio_testo').eq('scrutinio_id', scrutinioId),
    ])

    const alunniIds = (alunni ?? []).map((a) => a.id)
    const materieIds = (materie ?? []).map((m) => m.id)

    // Validazione completezza.
    const giudMap = new Set(
      (giudizi ?? [])
        .filter((g) => g.giudizio_sintetico && String(g.giudizio_sintetico).trim() !== '')
        .map((g) => `${g.alunno_id}:${g.materia_id}`)
    )
    const compMap = new Set(
      (comportamento ?? [])
        .filter((c) => c.giudizio_testo && String(c.giudizio_testo).trim() !== '')
        .map((c) => c.alunno_id)
    )

    const mancanti: { alunnoId: string; tipo: string; materiaId?: string }[] = []
    for (const aId of alunniIds) {
      for (const mId of materieIds) {
        if (!giudMap.has(`${aId}:${mId}`)) mancanti.push({ alunnoId: aId, tipo: 'disciplina', materiaId: mId })
      }
      if (!compMap.has(aId)) mancanti.push({ alunnoId: aId, tipo: 'comportamento' })
    }

    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Scrutinio incompleto: mancano giudizi.', incompleto: true, mancanti },
        { status: 422 }
      )
    }

    // Chiudi (lock).
    const { data: closed, error: closeErr } = await supabase
      .from('scrutini')
      .update({ stato: 'chiuso', chiuso_da: auth.user.id, chiuso_il: new Date().toISOString() })
      .eq('id', scrutinioId)
      .eq('stato', 'aperto')
      .select()
      .single()
    if (closeErr || !closed) return NextResponse.json({ error: closeErr?.message ?? 'Chiusura non riuscita' }, { status: 500 })

    // La chiusura blocca le proposte ma NON rende ancora visibili i voti ai
    // genitori: la visibilità avviene con la pubblicazione (/scrutinio/pubblica).
    return NextResponse.json({ success: true, data: closed })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
