import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, ricontrollaChiaveAttiva } from '@/lib/crm/ai/accesso'
import { caricaAgendaAi, GIORNI_MAX_AI, orariPerAssistente, sedeCopre, SLOT_MAX_AI } from '@/lib/crm/ai/disponibilita'
import { gradiPerNascita } from '@/lib/crm/ai/eta'
import { addGiorni } from '@/lib/format/data'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zAnnoMese, zDataYMD, zUuid } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'

const querySchema = z.strictObject({ sede: zUuid, dal: zDataYMD, al: zDataYMD, nascita: zAnnoMese }, {
  error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined,
})
  .refine((q) => q.al >= q.dal, { message: 'La data finale precede quella iniziale', path: ['al'] })
  .refine((q) => q.dal >= addGiorni(q.al, -GIORNI_MAX_AI), { message: `L’intervallo non può superare ${GIORNI_MAX_AI} giorni`, path: ['al'] })
  .refine((q) => q.al < '9999-12-31', { message: 'La data finale è troppo lontana', path: ['al'] })

export const GET = withRoute('crm/ai/slot:GET', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'slot')
  if ('response' in g) return g.response
  const { ai } = g

  const q = parseQuery(request, querySchema)
  if ('response' in q) return chiudiChiamataAi(ai, q.response)

  const altraSede = assertSedeDelToken(ai, q.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const supabase = await createAdminClient()
  const revocata = await ricontrollaChiaveAttiva(supabase, ai)
  if (revocata) return revocata

  const { dal, al, nascita } = q.data
  const adesso = new Date()
  const gradi = gradiPerNascita(nascita, dataCivile(adesso))
  const copertura = await sedeCopre(supabase, ai.scuolaId, gradi, 'crm/ai/slot')
  if ('response' in copertura) return chiudiChiamataAi(ai, copertura.response)

  const sede = ai.scuolaId
  if (!copertura.coperta) {
    return chiudiChiamataAi(ai, NextResponse.json({ sede, gradi, etaCoperta: false, troncato: false, slot: [] }))
  }

  const agenda = await caricaAgendaAi(supabase, ai.scuolaId, dal, al, adesso, 'crm/ai/slot')
  if ('response' in agenda) return chiudiChiamataAi(ai, agenda.response)

  const orari = orariPerAssistente(agenda.liberi)
  return chiudiChiamataAi(ai, NextResponse.json({
    sede,
    gradi,
    etaCoperta: true,
    troncato: orari.length > SLOT_MAX_AI,
    slot: orari.slice(0, SLOT_MAX_AI),
  }))
})
