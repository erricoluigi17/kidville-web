import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (requireDocente), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/primaria/sezioni?userId=
// Elenco delle sezioni di scuola primaria del PROPRIO plesso (o plessi, per la
// Direzione), usato per la "firma in un'altra classe" (supplenza). Gate ruolo +
// isolamento per tenant: niente sezioni di altri plessi.
export const GET = withRoute('primaria/sezioni:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('sections')
      .select('id, name, scuola_id')
      .eq('school_type', 'primaria')
      .in('scuola_id', plessi)
      .order('name')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/sezioni:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
