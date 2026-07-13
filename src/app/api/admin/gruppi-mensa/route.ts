import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// scuola_id permissivo (niente zUuid: nei test/dati seed circolano id non-UUID);
// la sede è risolta dallo scope reale dell'admin (resolveScuole*), non più da un default.
// `userId` in query è consumato dal gate (requireStaff), non qui.
const getQuerySchema = z.object({
  scuola_id: z.string().optional(),
})

const postBodySchema = z.object({
  nome: z.string({ error: 'nome obbligatorio' }).min(1, 'nome obbligatorio'),
  scuola_id: z.string().nullish(),
  // assente/null → true nell'handler (come oggi)
  attivo: z.boolean().nullish(),
})

// GET /api/admin/gruppi-mensa?scuola_id=&userId=  — elenco gruppi mensa.
export const GET = withRoute('admin/gruppi-mensa:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  try {
    const supabase = await createAdminClient()
    // Scope multi-sede: solo i plessi attivi (SedeSelector ∩ accessibili), mai cross-tenant.
    const { data, error } = await supabase
      .from('gruppi_mensa')
      .select('id, nome, attivo, scuola_id')
      .in('scuola_id', await resolveScuoleAttive(request, supabase, auth.user))
      .order('nome', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/gruppi-mensa:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/gruppi-mensa?userId=  — crea un gruppo mensa. body: { nome, scuola_id? }
export const POST = withRoute('admin/gruppi-mensa:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const body = b.data
  try {
    const supabase = await createAdminClient()
    // scuola_id: risolto dallo scope dell'admin (una sola sede per la scrittura).
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId
    const { data, error } = await supabase
      .from('gruppi_mensa')
      .insert({ nome: body.nome, scuola_id: scuolaId, attivo: body.attivo ?? true })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'gruppo_mensa',
      entitaId: data?.id ?? null,
      azione: 'insert',
      scuolaId,
      valoreDopo: data,
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'admin/gruppi-mensa:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
