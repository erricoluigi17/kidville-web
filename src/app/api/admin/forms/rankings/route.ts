import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// modelId resta stringa libera (niente zUuid): oggi il codice non impone alcun
// formato e nei test/dati seed circolano id non-UUID (es. 'm-1').
const getQuerySchema = z.object({
  modelId: z.string().optional(), // ''/assente → nessun filtro (come oggi)
})

// GET /api/admin/forms/rankings?modelId= — graduatoria (compilazioni completate
// ordinate per punteggio). Gated; sostituisce la lettura anon di `form_submissions`.
export async function GET(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { modelId } = q.data

  const supabase = await createAdminClient()
  let query = supabase
    .from('form_submissions')
    .select('id, model_id, user_id, data, score, signed_at, manual_adjustments, esito_ammissione, status, created_at, form_model:form_models(id, title)')
    .eq('status', 'completed')
    .order('score', { ascending: false })
    .order('signed_at', { ascending: true })

  if (modelId) query = query.eq('model_id', modelId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
