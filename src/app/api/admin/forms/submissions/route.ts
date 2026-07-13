import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Filtri tutti opzionali; la stringa vuota equivale a filtro assente (come il
// vecchio `if (searchParams.get(...))`), quindi si normalizza a undefined
// PRIMA di validare il formato.
const getQuerySchema = z.object({
    // Nessun vincolo sui valori nel codice attuale (l'enum esiste solo a DB).
    status: z.string().optional(),
    // uuid di form_models
    modelId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
    // giorno YYYY-MM-DD (input type=date); prima una data non parsabile
    // faceva crashare toISOString() → 500
    date: z.preprocess((v) => (v === '' ? undefined : v), zDataYMD.optional()),
})

// GET /api/admin/forms/submissions?status=&modelId=&date= — compilazioni con
// filtri. Gated; sostituisce la lettura anon di `form_submissions`.
export const GET = withRoute('admin/forms/submissions:GET', async (request: Request) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { status, modelId, date } = q.data

    const supabase = await createAdminClient()
    let query = supabase
      .from('form_submissions')
      .select('id, model_id, user_id, data, status, signed_at, created_at, gestita_il, gestita_da, form_model:form_models(id, title, schema)')
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (modelId) query = query.eq('model_id', modelId)
    if (date) {
      const from = new Date(date); from.setHours(0, 0, 0, 0)
      const to = new Date(date); to.setHours(23, 59, 59, 999)
      query = query.gte('created_at', from.toISOString()).lte('created_at', to.toISOString())
    }

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data ?? [])
})
