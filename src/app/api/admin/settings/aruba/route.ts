import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

const DEFAULT_SCUOLA = '11111111-1111-1111-1111-111111111111'

// Maschera la password_ref / non espone mai segreti in chiaro.
function sanitizeAruba(cfg: Record<string, unknown> | null) {
  const c = (cfg ?? {}) as Record<string, unknown>
  return {
    username: c.username ?? '',
    password_ref: c.password_ref ? '••••••' : '', // mai in chiaro
    has_password: !!c.password_ref,
    fiscal: c.fiscal ?? { piva: '', cf: '', ragione_sociale: '', sede: '', regime: '' },
    iva: c.iva ?? [],
    abilitato: c.abilitato ?? false,
    ambiente: c.ambiente ?? 'sandbox',
  }
}

// GET /api/admin/settings/aruba?userId=&scuola_id=  (staff) — config Aruba (mascherata)
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const scuolaId = searchParams.get('scuola_id') || auth.user.scuola_id || DEFAULT_SCUOLA

    const supabase = await createAdminClient()
    const { data } = await supabase.from('admin_settings').select('aruba_config').eq('scuola_id', scuolaId).maybeSingle()
    return NextResponse.json({ success: true, data: sanitizeAruba((data?.aruba_config as Record<string, unknown>) ?? null) })
  } catch (err) {
    console.error('Errore API GET aruba:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/settings/aruba  (staff) — aggiorna config Aruba
// Body: { userId, scuola_id?, username?, password_ref?, fiscal?, iva?, abilitato?, ambiente? }
// NB: la password reale non viene mai salvata in chiaro; si memorizza solo un
// riferimento (env/vault). Mai esposta ai parent (admin_settings senza RLS parent).
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const body = await request.json()
    const scuolaId = body.scuola_id || auth.user.scuola_id || DEFAULT_SCUOLA

    const supabase = await createAdminClient()
    const { data: cur } = await supabase.from('admin_settings').select('aruba_config').eq('scuola_id', scuolaId).maybeSingle()
    const existing = (cur?.aruba_config as Record<string, unknown>) ?? {}

    const next: Record<string, unknown> = { ...existing }
    if (body.username !== undefined) next.username = body.username
    // accetta solo un riferimento, mai una password in chiaro
    if (body.password_ref !== undefined && body.password_ref !== '••••••') next.password_ref = body.password_ref
    if (body.fiscal !== undefined) next.fiscal = body.fiscal
    if (body.iva !== undefined) next.iva = body.iva
    if (body.abilitato !== undefined) next.abilitato = body.abilitato
    if (body.ambiente !== undefined) next.ambiente = body.ambiente

    const { error } = await supabase
      .from('admin_settings')
      .upsert({ scuola_id: scuolaId, aruba_config: next }, { onConflict: 'scuola_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data: sanitizeAruba(next) })
  } catch (err) {
    console.error('Errore API PATCH aruba:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
