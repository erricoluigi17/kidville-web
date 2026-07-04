import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { getModuleConfig } from '@/lib/settings/module-config'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro (l'eventuale ?userId= legacy è ignorato)

// GET /api/diary/config — config diario per il docente (M5.4): espone le
// routine attive (diario_config.routine_attive) così la UI mostra solo i tipi
// evento abilitati dall'amministrazione (oggi usato per 'umore').
export async function GET(request: Request) {
  const auth = await requireDocente(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  try {
    const supabase = await createAdminClient()
    const cfg = await getModuleConfig<{ routine_attive?: unknown }>(
      supabase,
      'diario_config',
      auth.user.scuola_id,
    )
    return NextResponse.json({
      routine_attive: Array.isArray(cfg.routine_attive) ? cfg.routine_attive : [],
    })
  } catch (err) {
    console.error('Errore GET /api/diary/config:', err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
}
