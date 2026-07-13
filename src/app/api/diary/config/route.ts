import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { getModuleConfig } from '@/lib/settings/module-config'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro (l'eventuale ?userId= legacy è ignorato)

// GET /api/diary/config — config diario per il docente (M5.4): espone le
// routine attive (diario_config.routine_attive) così la UI mostra solo i tipi
// evento abilitati dall'amministrazione (oggi usato per 'umore'); espone anche
// `diario_primaria_visibile` (fail-open: default true) così la pagina
// `/teacher/diary` può nascondere le sezioni primaria se l'admin lo disattiva.
export const GET = withRoute('diary/config:GET', async (request: Request) => {
  const auth = await requireDocente(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  try {
    const supabase = await createAdminClient()
    const cfg = await getModuleConfig<{ routine_attive?: unknown; diario_primaria_visibile?: unknown }>(
      supabase,
      'diario_config',
      auth.user.scuola_id,
    )
    return NextResponse.json({
      routine_attive: Array.isArray(cfg.routine_attive) ? cfg.routine_attive : [],
      // fail-closed: il diario 0-6 è esposto alla primaria SOLO se l'admin lo attiva
      // esplicitamente (coerente con la dashboard "Nessuna attività infanzia/nido").
      diario_primaria_visibile: cfg.diario_primaria_visibile === true,
    })
  } catch (err) {
    logErrore({ operazione: 'diary/config:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
