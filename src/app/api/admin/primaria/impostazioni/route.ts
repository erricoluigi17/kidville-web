import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ============================================================
// Config globale primaria (admin_settings): matrice funzioni, scadenze
// vincoli temporali, buffer notifiche. Decisione: config globale in Impostazioni.
// ============================================================

const FIELDS = [
  'funzioni_matrice',
  'timelock_giorni_classe_orale',
  'timelock_giorni_scritto_pratico',
  'notif_buffer_valutazioni_min',
] as const

const getQuerySchema = z.object({
  scuolaId: zUuid,
})

// I campi FIELDS sono pass-through verso admin_settings (JSONB/numerici):
// schema permissivo per non alterare il comportamento attuale.
const patchBodySchema = z.object({
  scuolaId: zUuid,
  funzioni_matrice: z.unknown().optional(),
  timelock_giorni_classe_orale: z.unknown().optional(),
  timelock_giorni_scritto_pratico: z.unknown().optional(),
  notif_buffer_valutazioni_min: z.unknown().optional(),
})

// GET /api/admin/primaria/impostazioni?scuolaId=
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuolaId } = q.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('admin_settings')
      .select(FIELDS.join(', '))
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? {} })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/primaria/impostazioni?userId=  body: { scuolaId, ...campi }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { scuolaId, ...rest } = b.data

    const updates: Record<string, unknown> = {}
    for (const f of FIELDS) if (f in rest) updates[f] = rest[f]
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('admin_settings')
      .upsert({ scuola_id: scuolaId, ...updates }, { onConflict: 'scuola_id' })
      .select(FIELDS.join(', '))
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
