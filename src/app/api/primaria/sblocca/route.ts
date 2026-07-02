import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const ENTITA_TIPI = ['registro', 'valutazione', 'nota'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  entitaTipo: z.enum(ENTITA_TIPI, { error: `entitaTipo in ${ENTITA_TIPI.join('/')}` }),
  entitaId: zUuid,
  motivazione: z.string().min(1, 'motivazione obbligatoria'),
})

// POST /api/primaria/sblocca?userId=
// Override diretto del dirigente sul vincolo temporale. Riservato allo staff
// (admin/coordinator = dirigenza). Registra la motivazione in sblocchi_audit.
// body: { entitaTipo: 'registro'|'valutazione'|'nota', entitaId, motivazione }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { entitaTipo, entitaId, motivazione } = b.data

    const supabase = await createAdminClient()

    // Risolve l'entità → section_id e ne verifica lo scope PRIMA di scrivere
    // audit/lock: niente sblocchi cross-plesso né audit su id inesistenti.
    const entitaTable =
      entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : 'note_disciplinari'
    const { data: entita } = await supabase
      .from(entitaTable)
      .select('id, section_id')
      .eq('id', entitaId)
      .maybeSingle()
    if (!entita) return NextResponse.json({ error: 'Entità da sbloccare non trovata' }, { status: 404 })
    const scopeErr = await assertSezioneInScope(supabase, auth.user, entita.section_id as string)
    if (scopeErr) return scopeErr

    const { data, error } = await supabase
      .from('sblocchi_audit')
      .insert({ entita_tipo: entitaTipo, entita_id: entitaId, dirigente_id: auth.user.id, motivazione })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Azzera l'eventuale lock persistito (il blocco effettivo è comunque calcolato
    // in API: l'esistenza di questa riga di audit funge da override).
    const table = entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : null
    if (table) await supabase.from(table).update({ locked_il: null }).eq('id', entitaId)

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
