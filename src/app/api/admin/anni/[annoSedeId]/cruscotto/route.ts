import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import type { CruscottoAnno } from '@/lib/anno/cruscotto-tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * IL CRUSCOTTO DELL'ANNO PROSSIMO (PR 4.7, compito 4.7.6). `annoSedeId` = `anni_sede.id` dell'anno NUOVO, quello con le iscrizioni
 * aperte (stessa regola della pagina Conferme: `ANNO_NON_APERTO`, 409, altrimenti).
 *
 * I numeri li fa il database (`anno_cruscotto`, funzione di sola lettura): posti, risposte, quote in numero ed euro, incrocio fra
 * moduli e quota, confronto con la stessa data dell'anno prima. La route NON NOMINA NESSUN BAMBINO: restituisce numeri e nomi di
 * sezione. I nomi li danno le pagine che ne hanno diritto e il registro (Conferme, «chi non ha firmato in app»).
 *
 * Il percorso è quello di tutte le route dell'anno (`/api/admin/anni/[annoSedeId]/…`) e non `/api/admin/anno/cruscotto` della
 * specifica: l'anno sta nell'URL e il perimetro di sede (`assertAnnoSedeInScope`) lo giudica da lì, senza riscriverlo.
 *
 * Gate: staff (admin, coordinator, segreteria). Nei log: uuid e numeri.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

/** Nessun parametro in query: `userId` è consumato dal gate identità. */
const getQuerySchema = z.object({})

export const GET = withRoute('admin/anni/[annoSedeId]/cruscotto:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/cruscotto:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true } as const

  // L'anno dev'essere quello con le iscrizioni aperte.
  const anno = await supabase.from('anni_sede').select('id, stato').eq('id', annoSedeId).maybeSingle()
  if (anno.error) return rispostaErroreImpostazioni(anno.error, ctx)
  if ((anno.data as { stato?: string } | null)?.stato !== 'iscrizioni_aperte') {
    return rispostaErroreImpostazioni({ message: 'ANNO_NON_APERTO' }, ctx)
  }

  const r = await supabase.rpc('anno_cruscotto', { p_anno_sede: annoSedeId })
  if (r.error) return rispostaErroreImpostazioni(r.error, ctx)
  const data = r.data as CruscottoAnno | null
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    // Una funzione che risponde senza un oggetto non è una risposta: mai un 200 con un cruscotto vuoto.
    return rispostaErroreImpostazioni({ code: 'XX000', message: 'cruscotto:risposta-non-riconosciuta' }, ctx)
  }

  logEvento('anno-scolastico', 'info', { tipo: 'cruscotto-letto', operazione, anno_sede_id: annoSedeId, utente: auth.user.id })
  return NextResponse.json({ success: true, data })
})
