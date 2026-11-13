import { NextRequest, NextResponse } from 'next/server'
import { requireCrm } from '@/lib/crm/accesso'
import { assertSedeInScope, elementoNonTrovato } from '@/lib/crm/agenda'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { IntegrazioneRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData } from '@/lib/validation/http'

export const DELETE = withRoute(
  'admin/crm/integrazioni/[id]:DELETE',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const operazione = 'admin/crm/integrazioni/[id]:DELETE'
    if (auth.user.role !== 'admin') {
      logEvento('multi_sede', 'warn', {
        operazione, esito: 'integrazioni-non-admin', utente: auth.user.id, ruolo: auth.user.role,
      })
      return NextResponse.json({ error: 'Questa operazione è riservata alla Direzione.', codice: 'SOLO_ADMIN' }, { status: 403 })
    }

    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const supabase = await createAdminClient()

    const { data, error } = await supabase
      .from('crm_integrazioni')
      .select('id, scuola_id, revocata_il')
      .eq('id', idParsed.data)
      .maybeSingle()
    if (error) return rispostaErroreDbSchema(erroreDbSoloCodice(error), `${operazione}:lettura`)
    if (!data) return elementoNonTrovato()
    const riga = data as Pick<IntegrazioneRow, 'id' | 'scuola_id' | 'revocata_il'>

    const fuoriSede = await assertSedeInScope(supabase, auth.user, riga.scuola_id, operazione)
    if (fuoriSede) return fuoriSede

    let revocataOra = false
    if (riga.revocata_il === null) {
      // Se una seconda revoca arriva nel frattempo, il filtro preserva la prima data e il primo autore.
      const scrittura = await supabase
        .from('crm_integrazioni')
        .update({ revocata_il: new Date().toISOString(), revocata_da: auth.user.id })
        .eq('id', riga.id)
        .eq('scuola_id', riga.scuola_id)
        .is('revocata_il', null)
        .select('id')
      if (scrittura.error) return rispostaErroreDbSchema(erroreDbSoloCodice(scrittura.error), `${operazione}:scrittura`)
      revocataOra = (scrittura.data ?? []).length > 0
    }

    logEvento('crm', 'info', {
      operazione, esito: revocataOra ? 'integrazione-revocata' : 'integrazione-gia-revocata',
      scuola_id: riga.scuola_id, entita_id: riga.id,
    })
    return NextResponse.json({ id: riga.id, revocata: true })
  },
)
