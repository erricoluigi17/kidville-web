import { NextResponse, type NextRequest } from 'next/server'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  logIscrizioniAperte,
  risultatoScrittura,
  tracciaAnno,
  valoriApertura,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData } from '@/lib/validation/http'

const OPERAZIONE = 'admin/anni/[annoSedeId]/apri-iscrizioni:POST'

/**
 * POST — apre le iscrizioni di un anno `in_preparazione` (`anno_apri_iscrizioni`). Corpo vuoto: l'anno è
 * quello dell'URL, e chi apre è l'utente della sessione (finisce in `anni_sede_stati.da`).
 *
 * Prerequisiti mancanti → 409 `PREREQUISITI_MANCANTI` con l'elenco; già aperte → 200 `cambiato: false`
 * (aprire due volte non è un errore e non scrive una seconda riga di storico).
 */
export const POST = withRoute(
  'admin/anni/[annoSedeId]/apri-iscrizioni:POST',
  async (request: NextRequest, context: { params: Promise<{ annoSedeId: string }> }) => {
    const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria'])
    if (auth.response) return auth.response
    const { annoSedeId: grezzo } = await context.params

    const id = parseData(zUuid, grezzo)
    if ('response' in id) return id.response
    const annoSedeId = id.data

    const supabase = await createAdminClient()
    const annoLetto: { scuolaId?: string } = {}
    const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, OPERAZIONE, annoLetto)
    if (fuoriSede) return fuoriSede
    const chi = { utente: auth.user.id, annoSedeId }

    const { data, error } = await supabase.rpc('anno_apri_iscrizioni', { p_anno_sede: annoSedeId, p_da: auth.user.id })
    if (error) {
      return rispostaErroreImpostazioni(error, {
        ...chi,
        operazione: OPERAZIONE,
        tipoRifiuto: 'anno-iscrizioni-rifiutate',
      })
    }
    const r = risultatoScrittura(data)
    if (!r) return rispostaNonRiconosciuta(OPERAZIONE)

    if (r.cambiato) {
      logIscrizioniAperte(chi)
      await tracciaAnno(supabase, auth.user, annoSedeId, valoriApertura(r), annoLetto.scuolaId)
    }
    return NextResponse.json({ success: true, data: r })
  },
)
