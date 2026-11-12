import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { testoNotificaVisita } from '@/lib/crm/agenda'
import {
  assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi, type ContestoAi,
} from '@/lib/crm/ai/accesso'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { EsitoAnnullaAi } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData, parseQuery } from '@/lib/validation/http'

const operazione = 'crm/ai:annulla'
const querySchema = z.strictObject({ sede: zUuid }, {
  error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined,
})

// A cancellazione confermata, un guasto dell'avviso si registra e la visita resta annullata.
async function avvisaSegreteria(supabase: SupabaseClient, ai: ContestoAi, id: string): Promise<void> {
  const campiErrore = { operazione, esito: 'notifica-non-inviata', scuola_id: ai.scuolaId, entita_id: id }
  try {
    const { data, error } = await supabase
      .from('crm_appuntamenti')
      .select('assegnata_a, inizio')
      .eq('id', id)
      .eq('scuola_id', ai.scuolaId)
      .eq('integrazione_id', ai.integrazioneId)
      .eq('fissato_via', 'ai')
      .maybeSingle()
    if (error || !data) {
      logEvento('crm', 'error', campiErrore, erroreDbSoloCodice(error))
      return
    }

    const { corpo } = testoNotificaVisita(data.inizio)
    await notificaEvento(supabase, {
      tipo: 'crm_visita_annullata',
      scuolaId: ai.scuolaId,
      utenteIds: [data.assegnata_a],
      destinatario: 'personale',
      titolo: 'Visita annullata',
      corpo,
      link: '/admin/crm?tab=agenda',
      entitaTipo: 'crm_appuntamento',
      entitaId: id,
      bufferMin: 0,
    })
  } catch (error) {
    logEvento('crm', 'error', campiErrore, erroreDbSoloCodice(error))
  }
}

export const DELETE = withRoute(
  'crm/ai/prenotazioni/[id]:DELETE',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const g = await requireIntegrazioneAi(request, 'annulla')
    if ('response' in g) return g.response
    const { ai } = g

    const p = parseData(zUuid, (await context.params).id)
    if ('response' in p) return chiudiChiamataAi(ai, p.response)
    const q = parseQuery(request, querySchema)
    if ('response' in q) return chiudiChiamataAi(ai, q.response)

    const altraSede = assertSedeDelToken(ai, q.data.sede)
    if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

    const id = p.data.toLowerCase()
    const supabase = await createAdminClient()
    const { data, error } = await supabase.rpc('crm_ai_annulla', {
      p_integrazione_id: ai.integrazioneId,
      p_scuola_id: ai.scuolaId,
      p_appuntamento_id: id,
    })
    if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione))

    const rifiuta = (codice: CodiceAi, stato: number) => chiudiChiamataAi(ai, rifiutoAi(codice, stato), { codice })
    const esito = data as EsitoAnnullaAi | null
    switch (esito?.esito) {
      case 'non_trovato':
        return rifiuta('ELEMENTO_NON_TROVATO', 404)
      case 'stato_non_ammesso':
        return rifiuta('STATO_NON_AMMESSO', 409)
      case 'token_non_valido': {
        const risposta = rifiutoAi('TOKEN_NON_VALIDO', 401)
        risposta.headers.set('WWW-Authenticate', 'Bearer')
        return chiudiChiamataAi(ai, risposta, { codice: 'TOKEN_NON_VALIDO' })
      }
      case 'annullata': {
        if (esito.appuntamento_id !== id || typeof esito.gia_annullata !== 'boolean') break
        if (!esito.gia_annullata) {
          logEvento('crm', 'info', {
            operazione, esito: 'ai-visita-annullata', scuola_id: ai.scuolaId, entita_id: id,
          })
          await avvisaSegreteria(supabase, ai, id)
        }
        return chiudiChiamataAi(ai, NextResponse.json({
          id, annullata: true, giaAnnullata: esito.gia_annullata,
        }), { entitaId: id })
      }
    }

    logEvento('crm', 'error', { operazione, esito: 'esito-illeggibile', scuola_id: ai.scuolaId })
    return rifiuta('CRM_OPERAZIONE_NON_RIUSCITA', 500)
  },
)
