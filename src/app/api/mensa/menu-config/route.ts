import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({
  scuola_id: zUuid,
})

const postBodySchema = z.object({
  scuola_id: zUuid,
  nome: z.string().trim().min(1, 'nome è obbligatorio'),
  // oggi accettato senza vincoli di tipo → resta permissivo (default statico 0 nell'handler)
  ordine: z.unknown().optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  // in PATCH la stringa vuota è ammessa (comportamento attuale)
  nome: z.string().optional(),
  ordine: z.unknown().optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/mensa/menu-config?scuola_id=  — tutti i menu della scuola
export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const scuolaId = q.data.scuola_id

    const supabase = await createAdminClient()
    const accessibili = await resolveScuoleAttive(request, supabase, auth.user)
    // scuola_id dal client SOLO per restringere dentro le sedi accessibili
    const plessi = accessibili.includes(scuolaId) ? [scuolaId] : accessibili
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .select('id, nome, ordine, created_at')
      .in('scuola_id', plessi)
      .order('ordine', { ascending: true })
    if (error) throw error
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('GET /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/mensa/menu-config  { scuola_id, nome, ordine? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuola_id, nome, ordine = 0 } = b.data
    const supabase = await createAdminClient()
    // sede derivata server-side (valida scuola_id client ∈ sedi dell'utente)
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, scuola_id)
    if (sw.response) return sw.response
    const sede = sw.scuolaId as string
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .insert({ scuola_id: sede, nome, ordine })
      .select('id, nome, ordine')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('POST /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/mensa/menu-config  { id, nome?, ordine? }
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, nome, ordine } = b.data

    const updates: Record<string, unknown> = {}
    if (nome !== undefined) updates.nome = nome.trim()
    if (ordine !== undefined) updates.ordine = ordine

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('mensa_menu_config')
      .update(updates)
      .eq('id', id)
      .select('id, nome, ordine')
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('PATCH /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/mensa/menu-config?id=
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    const supabase = await createAdminClient()
    // Blocca eliminazione se ci sono rotazioni/override collegati
    const [{ count: cRot }, { count: cOvr }] = await Promise.all([
      supabase.from('mensa_menu_rotazione').select('id', { count: 'exact', head: true }).eq('menu_config_id', id),
      supabase.from('mensa_menu_override').select('id', { count: 'exact', head: true }).eq('menu_config_id', id),
    ])
    if ((cRot ?? 0) > 0 || (cOvr ?? 0) > 0) {
      return NextResponse.json({ error: 'Impossibile eliminare: il menu ha voci di rotazione o override associati.' }, { status: 409 })
    }

    const { error } = await supabase.from('mensa_menu_config').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('DELETE /api/mensa/menu-config:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
