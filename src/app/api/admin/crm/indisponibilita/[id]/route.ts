import { NextResponse, type NextRequest } from 'next/server'
import { requireCrm } from '@/lib/crm/accesso'
import { assertSedeInScope, elementoNonTrovato, puoToccareDi, soloLaPropria } from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import type { IndisponibilitaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · toglie un'assenza o una chiusura di sede.
 *
 * `DELETE /api/admin/crm/indisponibilita/[id]`. Un'assenza PERSONALE la toglie la persona o l'admin
 * (`403 SOLO_LA_PROPRIA`); una CHIUSURA DI SEDE (`utente_id` nullo) la toglie qualsiasi segretaria della sede,
 * come qualsiasi segretaria della sede può inserirla. La sede della riga è quella letta dal database, e il
 * `delete` porta comunque `.eq('scuola_id')`.
 */
export const DELETE = withRoute(
  'admin/crm/indisponibilita/[id]:DELETE',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const supabase = await createAdminClient()
    const operazione = 'admin/crm/indisponibilita/[id]:DELETE'

    const letta = await supabase.from('crm_indisponibilita').select('*').eq('id', id).maybeSingle()
    if (letta.error) return rispostaErroreDb(letta.error, `${operazione}:lettura`)
    if (!letta.data) return elementoNonTrovato()
    const assenza = letta.data as IndisponibilitaRow

    const fuoriSede = await assertSedeInScope(supabase, auth.user, assenza.scuola_id, operazione)
    if (fuoriSede) return fuoriSede
    if (assenza.utente_id !== null && !puoToccareDi(auth.user, assenza.utente_id)) return soloLaPropria()

    const { data, error } = await supabase
      .from('crm_indisponibilita')
      .delete()
      .eq('id', id)
      .eq('scuola_id', assenza.scuola_id)
      .select('id')
    if (error) return rispostaErroreDb(error, operazione)
    if ((data ?? []).length === 0) return elementoNonTrovato()

    logEvento('crm', 'info', {
      operazione,
      esito: assenza.utente_id === null ? 'chiusura-di-sede-eliminata' : 'assenza-eliminata',
      scuola_id: assenza.scuola_id,
      entita_id: id,
    })
    return NextResponse.json({ id })
  },
)
