import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  anno: z.coerce.number().int().min(2000).max(2100).optional(),
})

// Registro/colonne assenti (DB e2e CI non migrato) → lista vuota, mai crash.
const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

// GET /api/pagamenti/ricevute?anno=&userId= — registro ricevute emesse (staff).
// Include le annullate (numero bruciato + motivo): il registro resta coerente.
export const GET = withRoute('pagamenti/ricevute:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    let query = supabase
      .from('ricevute_emesse')
      .select('id, pagamento_id, numero, anno, importo, periodo_competenza, metodi, tracciabile, bollo, annullata_il, annullo_motivo, creato_il, alunni:alunno_id ( nome, cognome )')
      .in('scuola_id', sediAttive)
      .order('anno', { ascending: false })
      .order('numero', { ascending: false })
      .limit(500)
    if (q.data.anno) query = query.eq('anno', q.data.anno)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) {
        return NextResponse.json({ success: true, data: [], disponibile: false })
      }
      console.error('Errore registro ricevute:', error)
      return NextResponse.json({ error: 'Errore nel recupero del registro ricevute' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ricevute:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
