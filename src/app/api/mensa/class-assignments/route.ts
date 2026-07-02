import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'

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

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/mensa/class-assignments?scuola_id=
// Ritorna tutte le assegnazioni (incluse quelle future), ordinate per classe + data.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const scuolaId = q.data.scuola_id

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .select('id, classe, menu_config_id, attivo_dal, created_at, mensa_menu_config(nome)')
      .eq('scuola_id', scuolaId)
      .order('classe', { ascending: true })
      .order('attivo_dal', { ascending: false })
    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('GET /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/mensa/class-assignments  { scuola_id, classe, menu_config_id, attivo_dal }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuola_id, classe, menu_config_id, attivo_dal } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_class_menu_assignment')
      .insert({ scuola_id, classe, menu_config_id, attivo_dal })
      .select('id, classe, menu_config_id, attivo_dal')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('POST /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/class-assignments?id=
export async function DELETE(request: Request) {
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
    console.error('DELETE /api/mensa/class-assignments:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
