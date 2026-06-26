import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'

// PATCH /api/admin/forms/submissions/[id] — modifica manuale del punteggio
// (manual_adjustments → il trigger DB ricalcola lo score). Gated + audit.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const { id } = await ctx.params
  try {
    const body = await request.json()
    const updates: Record<string, unknown> = {}
    if (body.manual_adjustments !== undefined) updates.manual_adjustments = body.manual_adjustments
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
    console.error('Errore PATCH /api/admin/forms/submissions/[id]:', err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
}
