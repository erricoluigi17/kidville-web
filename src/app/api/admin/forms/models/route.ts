import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/admin/forms/models — elenco modelli (id, title) per i filtri admin.
// Gated (Segreteria+Direzione); sostituisce la lettura anon di `form_models`.
export const GET = withRoute('admin/forms/models:GET', async (request: Request) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // id, title per i filtri admin (consumo storico) + campi pubblicazione per la
    // sezione Iscrizioni → Moduli inviabili (backward-compatible: solo campi in più).
    const { data, error } = await supabase
      .from('form_models')
      .select('id, title, description, is_active, is_enrollment_form, published_at, public_token, access_mode, created_at')
      .order('title')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data ?? [])
})
