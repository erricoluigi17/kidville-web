import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { personeDellaSede, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · le persone a cui in una sede si può assegnare una visita.
 *
 * `GET /api/admin/crm/persone?scuolaId=<uuid>` → `200 { data: [{ id, nome, cognome, ruolo }] }`.
 *
 * La sede si DICHIARA (mai indovinata): è richiesta, e deve stare fra le sedi attive dell'utente
 * (`resolveScuoleAttive` + `restringiSedi`, che restituisce la forma canonica e ignora le maiuscole).
 * Una sede non propria è un 403 `SEDE_NON_ACCESSIBILE`, non un elenco vuoto.
 */

const querySchema = z.object({ scuolaId: zUuid })

export const GET = withRoute('admin/crm/persone:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/persone:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  try {
    return NextResponse.json({ data: await personeDellaSede(supabase, scuole[0]) })
  } catch (err) {
    return rispostaErroreDb(err as { code?: string; message?: string }, 'admin/crm/persone:GET')
  }
})
