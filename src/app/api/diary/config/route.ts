import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { scuoleDiUtente, formaConfronto } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { getModuleConfig } from '@/lib/settings/module-config'
import { routinePersonalizzate } from '@/lib/diary/routine'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  // La sede di cui si compila il diario (2026-09-28): il cockpit di segreteria la sceglie dal
  // selettore. Assente = la sede dell'utente, come prima. (L'eventuale ?userId= legacy è ignorato.)
  scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
})

// GET /api/diary/config — config diario per il docente (M5.4): espone le
// routine attive (diario_config.routine_attive) così la UI mostra solo i tipi
// evento abilitati dall'amministrazione; espone anche `diario_primaria_visibile`
// (fail-closed) così la pagina `/teacher/diary` può nascondere le sezioni primaria.
//
// Dal 2026-09-28 le routine FUNZIONANO (non solo l'umore) e la segreteria può aggiungerne:
//  · `routine_attive` è `null` quando la sede non ha mai scelto. Prima diventava `[]`, ma una
//    lista vuota oggi vuol dire «tutto spento»: una sede nuova avrebbe perso tutti i bottoni;
//  · `routine_personalizzate` porta le routine della scuola ATTIVE e valide;
//  · `?scuola_id=` legge la sede che si sta compilando, se è fra quelle dell'utente.
export const GET = withRoute('diary/config:GET', async (request: Request) => {
  const auth = await requireDocente(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  try {
    const supabase = await createAdminClient()

    let sede: string | null | undefined = auth.user.scuola_id
    if (q.data.scuola_id) {
      const accessibili = await scuoleDiUtente(supabase, auth.user)
      sede = accessibili.find((s) => formaConfronto(s) === formaConfronto(q.data.scuola_id as string))
      if (!sede) return rifiutoSede('SEDE_NON_ACCESSIBILE')
    }

    const cfg = await getModuleConfig<{
      routine_attive?: unknown
      routine_personalizzate?: unknown
      diario_primaria_visibile?: unknown
    }>(supabase, 'diario_config', sede)
    return NextResponse.json({
      routine_attive: Array.isArray(cfg.routine_attive) ? cfg.routine_attive : null,
      routine_personalizzate: routinePersonalizzate(cfg.routine_personalizzate).filter((r) => r.attiva),
      // fail-closed: il diario 0-6 è esposto alla primaria SOLO se l'admin lo attiva
      // esplicitamente (coerente con la dashboard "Nessuna attività infanzia/nido").
      diario_primaria_visibile: cfg.diario_primaria_visibile === true,
    })
  } catch (err) {
    logErrore({ operazione: 'diary/config:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
