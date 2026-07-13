import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Aggiornabili: manual_adjustments (jsonb libero, il trigger DB ricalcola lo
// score) e gestita (M5.2: il server deriva gestita_il/gestita_da, mai dal body).
// NB zod v4: z.unknown() nudo rende la chiave obbligatoria → serve .optional().
const patchBodySchema = z.object({
    manual_adjustments: z.unknown().optional(),
    gestita: z.boolean().optional(),
})

// PATCH /api/admin/forms/submissions/[id] — modifica manuale del punteggio
// (manual_adjustments → il trigger DB ricalcola lo score) e presa in carico
// ("Segna gestita" → gestita_il/gestita_da). Gated + audit.
export const PATCH = withRoute('admin/forms/submissions/[id]:PATCH', async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    // Param dinamico: id submission, usato come uuid nelle query (M3).
    const { id: rawId } = await ctx.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response

    try {
      const updates: Record<string, unknown> = {}
      if (b.data.manual_adjustments !== undefined) updates.manual_adjustments = b.data.manual_adjustments
      if (b.data.gestita !== undefined) {
        updates.gestita_il = b.data.gestita ? new Date().toISOString() : null
        updates.gestita_da = b.data.gestita ? auth.user.id : null
      }
      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
      }

      const supabase = await createAdminClient()
      const { data: prima } = await supabase.from('form_submissions').select('*').eq('id', id).maybeSingle()

      const { data, error } = await supabase
        .from('form_submissions')
        .update(updates)
        .eq('id', id)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'graduatoria',
        entitaId: id,
        azione: 'update',
        valorePrima: prima ?? null,
        valoreDopo: updates,
      })

      return NextResponse.json(data)
    } catch (err) {
      logErrore({ operazione: 'admin/forms/submissions/[id]:PATCH', stato: 500 }, err)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
})
