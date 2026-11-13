import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, ricontrollaChiaveAttiva } from '@/lib/crm/ai/accesso'
import { dettagliSchede } from '@/lib/crm/ai/contatti'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { SchedaRow } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'

const op = 'crm/ai/contatti/nuovi'
const querySchema = z.strictObject({
  sede: zUuid,
  dopo: z.iso.datetime({ offset: true }),
  dopoId: zUuid.optional(),
}, { error: (issue) => issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined })

type SchedaNuova = Pick<SchedaRow, 'id' | 'creata_il' | 'telefoni_norm' | 'origine'>

export const GET = withRoute('crm/ai/contatti/nuovi:GET', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'contatti_nuovi')
  if ('response' in g) return g.response
  const { ai } = g

  const q = parseQuery(request, querySchema)
  if ('response' in q) return chiudiChiamataAi(ai, q.response)

  const altraSede = assertSedeDelToken(ai, q.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const supabase = await createAdminClient()
  const revocata = await ricontrollaChiaveAttiva(supabase, ai)
  if (revocata) return revocata

  const { dopo, dopoId } = q.data
  const selezione = supabase.from('crm_schede')
    .select('id, creata_il, telefoni_norm, origine')
    .eq('scuola_id', ai.scuolaId)
    .eq('creato_via', 'segreteria')
    .is('anonimizzata_il', null)

  // ISO e UUID sono già validati. Conserviamo i microsecondi del database nel cursore.
  const pagina = dopoId
    ? selezione.or(`creata_il.gt."${dopo}",and(creata_il.eq."${dopo}",id.gt.${dopoId})`)
    : selezione.gt('creata_il', dopo)
  const { data, error } = await pagina
    .order('creata_il', { ascending: true })
    .order('id', { ascending: true })
    .limit(100)
    .overrideTypes<SchedaNuova[], { merge: false }>()
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), op))

  const schede = data ?? []
  const dettagli = await dettagliSchede(supabase, ai.scuolaId, schede.map(({ id }) => id), new Date(), op)
  if ('response' in dettagli) return chiudiChiamataAi(ai, dettagli.response)

  const contatti = schede.map(({ id, creata_il, telefoni_norm, origine }) => {
    const scheda = dettagli.perScheda.get(id)
    return {
      schedaId: id, creataIl: creata_il, telefono: telefoni_norm[0] ?? null, origine,
      visita: scheda?.visita ?? null, bambini: scheda?.bambini ?? [],
    }
  })
  const ultima = schede.at(-1)
  return chiudiChiamataAi(ai, NextResponse.json({
    contatti, prossimoDopo: ultima?.creata_il ?? null, prossimoDopoId: ultima?.id ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } }))
})
