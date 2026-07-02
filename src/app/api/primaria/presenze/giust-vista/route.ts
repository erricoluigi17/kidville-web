import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  presenzaId: zUuid,
})

// POST /api/primaria/presenze/giust-vista?userId=
// body: { presenzaId }
// Il docente registra la presa visione della giustifica del genitore.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { presenzaId } = b.data

    const supabase = await createAdminClient()
    // Risolve la presenza → section_id e ne verifica lo scope prima dell'update.
    const { data: presenza } = await supabase
      .from('presenze')
      .select('id, section_id')
      .eq('id', presenzaId)
      .maybeSingle()
    if (!presenza) return NextResponse.json({ error: 'Presenza non trovata' }, { status: 404 })
    const scopeErr = await assertSezioneInScope(supabase, auth.user, presenza.section_id as string)
    if (scopeErr) return scopeErr

    const { data: updated, error } = await supabase
      .from('presenze')
      .update({ giust_vista_il: new Date().toISOString(), giust_vista_da: userId })
      .eq('id', presenzaId)
      .eq('giustificata', true)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Presenza non giustificata o inesistente' }, { status: 404 })

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
