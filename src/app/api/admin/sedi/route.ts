import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/admin/sedi
// Elenco delle sedi ACCESSIBILI all'utente loggato (non l'intero registry):
// admin → utenti.scuola_id + utenti_scuole; segreteria/coordinator → il proprio
// plesso. È la fonte del SedeSelector multi-sede: gli id qui coincidono con
// quelli su cui `resolveScuoleAttive`/`resolveScuolaScrittura` filtrano
// (schools.id), così la selezione nel cookie `sedi_attive` scopa davvero i dati.
// Distinto da /api/admin/schools, che è il CRUD del registry `scuole` (Direzione).
export const GET = withRoute('admin/sedi:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const plessi = await scuoleDiUtente(supabase, auth.user)
  if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

  const { data, error } = await supabase
    .from('schools')
    .select('id, nome')
    .in('id', plessi)
    .order('nome', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: data ?? [] })
})
