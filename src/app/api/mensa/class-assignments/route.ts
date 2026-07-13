import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  scuola_id: zUuid,
})

const postBodySchema = z.object({
  scuola_id: zUuid,
  // trim come nel vecchio insert; vuoto/solo spazi era già rifiutato con 400
  classe: z.string().trim().min(1, 'classe è obbligatoria'),
  menu_config_id: zUuid,
  attivo_dal: zDataYMD,
})

// PUT: set semantics — sostituisce l'elenco sezioni assegnate a un menu.
const putBodySchema = z.object({
  scuola_id: zUuid,
  menu_config_id: zUuid,
  classi: z.array(z.string().trim().min(1)).max(200),
  attivo_dal: zDataYMD.optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/mensa/class-assignments?scuola_id=
// Ritorna tutte le assegnazioni (incluse quelle future), ordinate per classe + data.
export const GET = withRoute('mensa/class-assignments:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const scuolaId = q.data.scuola_id

    const supabase = await createAdminClient()
    const accessibili = await resolveScuoleAttive(request, supabase, auth.user)
    // Usa lo scuola_id del client SOLO per restringere entro i plessi accessibili.
    const plessi = accessibili.includes(scuolaId) ? [scuolaId] : accessibili
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .select('id, classe, menu_config_id, attivo_dal, created_at, mensa_menu_config(nome)')
      .in('scuola_id', plessi)
      .order('classe', { ascending: true })
      .order('attivo_dal', { ascending: false })
    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'mensa/class-assignments:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/mensa/class-assignments  { scuola_id, classe, menu_config_id, attivo_dal }
export const POST = withRoute('mensa/class-assignments:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuola_id, classe, menu_config_id, attivo_dal } = b.data

    const supabase = await createAdminClient()
    const { scuolaId: sede, response } = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id)
    if (response) return response
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .insert({ scuola_id: sede, classe, menu_config_id, attivo_dal })
      .select('id, classe, menu_config_id, attivo_dal')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'mensa/class-assignments:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PUT /api/mensa/class-assignments  { scuola_id, menu_config_id, classi: string[], attivo_dal? }
// Rimpiazza tutte le sezioni assegnate a quel menu con l'elenco fornito (multi-select).
export const PUT = withRoute('mensa/class-assignments:PUT', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, putBodySchema)
    if ('response' in b) return b.response
    const { scuola_id, menu_config_id, classi, attivo_dal } = b.data

    const supabase = await createAdminClient()
    const { scuolaId: sede, response } = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id)
    if (response) return response

    const { error: delErr } = await supabase
      .from('mensa_class_menu_assignment')
      .delete()
      .eq('scuola_id', sede)
      .eq('menu_config_id', menu_config_id)
    if (delErr) throw delErr

    const dal = attivo_dal ?? new Date().toISOString().split('T')[0]
    const uniche = [...new Set(classi)]
    if (uniche.length > 0) {
      const rows = uniche.map((classe) => ({ scuola_id: sede, classe, menu_config_id, attivo_dal: dal }))
      const { error: insErr } = await supabase.from('mensa_class_menu_assignment').insert(rows)
      if (insErr) throw insErr
    }
    return NextResponse.json({ success: true, count: uniche.length })
  } catch (err) {
    logErrore({ operazione: 'mensa/class-assignments:PUT', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/mensa/class-assignments?id=
export const DELETE = withRoute('mensa/class-assignments:DELETE', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { error } = await supabase.from('mensa_class_menu_assignment').delete().eq('id', q.data.id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'mensa/class-assignments:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
