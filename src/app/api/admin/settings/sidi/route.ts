import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) → "non fornito",
 * così il codice lascia che sia resolveScuolaScrittura a risolvere la sede.
 */
const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

// Campi della config SIDI: oggi accettati senza vincoli di tipo (finiscono in
// JSONB via merge server-side): schema volutamente permissivo. L'.optional() su
// z.unknown() è OBBLIGATORIO (in zod v4 z.unknown() nudo è required a runtime).
const patchBodySchema = z.object({
  scuola_id: zScuolaId,
  codice_meccanografico: z.unknown().optional(),
  username: z.unknown().optional(),
  password_ref: z.unknown().optional(),
  abilitato: z.unknown().optional(),
  ambiente: z.unknown().optional(),
})

// Config SIDI sanitizzata: password_ref mai esposta in chiaro.
function sanitizeSidi(cfg: Record<string, unknown> | null) {
  const c = (cfg ?? {}) as Record<string, unknown>
  return {
    codice_meccanografico: c.codice_meccanografico ?? '',
    username: c.username ?? '',
    password_ref: c.password_ref ? '••••••' : '',
    has_password: !!c.password_ref,
    abilitato: c.abilitato ?? false,
    ambiente: c.ambiente ?? 'demo',
  }
}

// GET /api/admin/settings/sidi?userId=&scuola_id=  (staff) — config SIDI mascherata.
export const GET = withRoute('admin/settings/sidi:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId

      const { data } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()
      return NextResponse.json({ success: true, data: sanitizeSidi((data?.sidi_config as Record<string, unknown>) ?? null) })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/sidi:GET', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// PATCH /api/admin/settings/sidi  (staff) — aggiorna config SIDI (merge server-side).
// La password reale non è mai salvata in chiaro: solo un riferimento env (password_ref).
export const PATCH = withRoute('admin/settings/sidi:PATCH', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response
      const body = b.data

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId

      const { data: cur } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()
      const existing = (cur?.sidi_config as Record<string, unknown>) ?? {}

      const next: Record<string, unknown> = { ...existing }
      if (body.codice_meccanografico !== undefined) next.codice_meccanografico = body.codice_meccanografico
      if (body.username !== undefined) next.username = body.username
      if (body.password_ref !== undefined && body.password_ref !== '••••••') next.password_ref = body.password_ref
      if (body.abilitato !== undefined) next.abilitato = body.abilitato
      if (body.ambiente !== undefined) next.ambiente = body.ambiente

      const { error } = await supabase
        .from('admin_settings')
        .upsert({ scuola_id: scuolaId, sidi_config: next }, { onConflict: 'scuola_id' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      return NextResponse.json({ success: true, data: sanitizeSidi(next) })
    } catch (err) {
      logErrore({ operazione: 'admin/settings/sidi:PATCH', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})
