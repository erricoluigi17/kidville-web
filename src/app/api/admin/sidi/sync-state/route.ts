import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { loadSyncState } from '@/lib/sidi/sync-store'
import { prossimaFase } from '@/lib/sidi/sequenza'

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

// GET /api/admin/sidi/sync-state?userId=  — stato indicatore Fase A → freq. → PU.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const supabase = await createAdminClient()
    const scuolaId = auth.user.scuola_id || SCUOLA_ID_DEFAULT
    const state = await loadSyncState(supabase, scuolaId)
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
