import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

// GET /api/admin/gruppi-mensa?scuola_id=&userId=  — elenco gruppi mensa.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const scuolaId = new URL(request.url).searchParams.get('scuola_id') || auth.user.scuola_id || SCUOLA_ID_DEFAULT
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('gruppi_mensa')
      .select('id, nome, attivo, scuola_id')
      .eq('scuola_id', scuolaId)
      .order('nome', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/gruppi-mensa?userId=  — crea un gruppo mensa. body: { nome, scuola_id? }
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const body = await request.json().catch(() => ({}))
    if (!body.nome) return NextResponse.json({ error: 'nome obbligatorio' }, { status: 400 })
    const scuolaId = body.scuola_id || auth.user.scuola_id || SCUOLA_ID_DEFAULT
    const supabase = await createAdminClient()
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
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
