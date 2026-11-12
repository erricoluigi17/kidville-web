import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi } from '@/lib/crm/ai/accesso'
import { dettagliSchede, schedaPerTelefono } from '@/lib/crm/ai/contatti'
import { normalizzaTelefonoAi } from '@/lib/crm/ai/telefono'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody } from '@/lib/validation/http'

const op = 'crm/ai/contatti/stato'
const bodySchema = z.strictObject({
  sede: zUuid,
  telefono: z.string().trim().min(6).max(40),
}, { error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined })

export const POST = withRoute('crm/ai/contatti/stato:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'contatto_stato')
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const telefonoNorm = normalizzaTelefonoAi(b.data.telefono)
  if (telefonoNorm === null) {
    return chiudiChiamataAi(ai, rifiutoAi('CONTATTO_OBBLIGATORIO', 422), { codice: 'CONTATTO_OBBLIGATORIO' })
  }

  const supabase = await createAdminClient()
  const trovata = await schedaPerTelefono(supabase, ai.scuolaId, telefonoNorm, op)
  if ('response' in trovata) return chiudiChiamataAi(ai, trovata.response)
  if (!trovata.scheda) {
    return chiudiChiamataAi(ai, NextResponse.json({
      esiste: false, schedaId: null, creatoVia: null, visita: null, bambini: [],
    }))
  }

  const { id: schedaId, creato_via: creatoVia } = trovata.scheda
  const dettagli = await dettagliSchede(supabase, ai.scuolaId, [schedaId], new Date(), op)
  if ('response' in dettagli) return chiudiChiamataAi(ai, dettagli.response, { entitaId: schedaId })

  const scheda = dettagli.perScheda.get(schedaId)
  return chiudiChiamataAi(ai, NextResponse.json({
    esiste: true, schedaId, creatoVia, visita: scheda?.visita ?? null, bambini: scheda?.bambini ?? [],
  }), { entitaId: schedaId })
})
