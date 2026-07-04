import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { loadSyncState } from '@/lib/sidi/sync-store'
import { prossimaFase } from '@/lib/sidi/sequenza'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({ scuola_id: z.string().uuid().optional() })

// GET /api/admin/sidi/sync-state?userId=  — stato indicatore Fase A → freq. → PU.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  try {
    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const state = await loadSyncState(supabase, sw.scuolaId!)
    return NextResponse.json({
      success: true,
      data: state,
      prossima: prossimaFase({ fase_a_stato: state.fase_a_stato, frequentanti_stato: state.frequentanti_stato }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
