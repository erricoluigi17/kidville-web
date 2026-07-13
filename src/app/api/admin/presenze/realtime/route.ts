import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { aggregaPresenze, TOTALE_VUOTO } from '@/lib/presenze/aggregate'
import { withRoute } from '@/lib/logging/with-route'

/**
 * GET /api/admin/presenze/realtime — aggregato presenze di OGGI per il
 * monitoraggio multi-sede del cockpit (M7.4). Riservato allo staff e scoped
 * ai plessi di scuoleDiUtente(): iscritti per scuola/classe, presenze
 * raggruppate, appelli_mancanti = classi con 0 righe. Il client fa poll 60s
 * (niente canali realtime). L'aggregazione è nella funzione pura
 * aggregaPresenze (src/lib/presenze/aggregate.ts).
 */

const getQuerySchema = z.object({}) // nessun parametro in ingresso

export const GET = withRoute('admin/presenze/realtime:GET', async (request: Request) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const plessi = await scuoleDiUtente(supabase, auth.user)
  if (plessi.length === 0) {
    return NextResponse.json({ success: true, data: { totale: TOTALE_VUOTO, sedi: [] } })
  }

  const today = new Date().toISOString().slice(0, 10)

  const [alunniRes, presenzeRes, sectionsRes, schoolsRes] = await Promise.all([
    supabase
      .from('alunni')
      .select('id, section_id, scuola_id')
      .in('scuola_id', plessi)
      .eq('stato', 'iscritto'),
    // Scope in query via join sull'alunno; l'aggregazione ignora comunque
    // le righe di alunni fuori elenco (doppia cintura).
    supabase
      .from('presenze')
      .select('alunno_id, stato, alunni!inner ( scuola_id )')
      .eq('data', today)
      .in('alunni.scuola_id', plessi)
      .limit(5000),
    supabase.from('sections').select('id, name, scuola_id').in('scuola_id', plessi),
    supabase.from('schools').select('id, nome').in('id', plessi),
  ])

  const data = aggregaPresenze(
    alunniRes.data ?? [],
    presenzeRes.data ?? [],
    sectionsRes.data ?? [],
    schoolsRes.data ?? []
  )

  return NextResponse.json({ success: true, data })
})
