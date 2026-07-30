import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// modelId resta stringa libera (niente zUuid): oggi il codice non impone alcun
// formato e nei test/dati seed circolano id non-UUID (es. 'm-1').
const getQuerySchema = z.object({
  modelId: z.string().optional(), // ''/assente → nessun filtro (come oggi)
})

// GET /api/admin/forms/rankings?modelId= — graduatoria (compilazioni completate
// ordinate per punteggio). Gated; sostituisce la lettura anon di `form_submissions`.
export const GET = withRoute('admin/forms/rankings:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { modelId } = q.data

    // Isolamento per sede. Prima non esisteva NESSUN modo di sapere a quale plesso
    // appartenesse una compilazione (nessuna colonna, e `user_id` senza FK): elenchi,
    // graduatorie ed export mostravano i dati delle famiglie delle tre sedi a
    // qualunque segreteria. La colonna esiste dalla migrazione
    // `modulistica_sede_su_modelli_e_compilazioni` (2026-07-30) ed è scritta
    // all'invio. Scope vuoto ⇒ nessuna riga.
    const supabase = await createAdminClient()
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    const costruisci = (conSede: boolean) => {
      let query = supabase
        .from('form_submissions')
        .select('id, model_id, user_id, data, score, signed_at, manual_adjustments, esito_ammissione, status, created_at, form_model:form_models(id, title)')
        .eq('status', 'completed')
        .order('score', { ascending: false })
        .order('signed_at', { ascending: true })
      if (conSede) query = query.in('scuola_id', plessi)
      if (modelId) query = query.eq('model_id', modelId)
      return query
    }

    let res = await costruisci(true)
    if (colonnaSedeAssente(res.error)) {
      if (!(await degradoSedeLecito(supabase, 'admin/forms/rankings:GET'))) {
        return NextResponse.json({ error: 'Isolamento per sede non disponibile' }, { status: 500 })
      }
      res = await costruisci(false)
    }
    const { data, error } = res
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data ?? [])
})
