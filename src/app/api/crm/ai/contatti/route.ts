import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi } from '@/lib/crm/ai/accesso'
import { dettagliSchede, type VisitaAi } from '@/lib/crm/ai/contatti'
import { normalizzaTelefonoAi } from '@/lib/crm/ai/telefono'
import { normalizzaEmail } from '@/lib/crm/contatti'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import { ORIGINI } from '@/lib/crm/tipi'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zOpzionale, zUuid } from '@/lib/validation/common'
import { parseBody } from '@/lib/validation/http'

const op = 'crm/ai/contatti'
const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const bambinoSchema = z.strictObject({
  nome: zOpzionale(z.string().trim().min(1).max(100)),
  dataNascita: zOpzionale(zDataYMD),
}, campiAmmessi)
const bodySchema = z.strictObject({
  sede: zUuid,
  telefono: z.string().trim().min(6).max(40),
  genitoreNome: zOpzionale(z.string().trim().min(1).max(120)),
  email: zOpzionale(z.string().trim().max(200)),
  origine: z.enum(ORIGINI),
  bambini: z.array(bambinoSchema).max(6).optional(),
}, campiAmmessi)
const esitoRpcSchema = z.object({ scheda_id: zUuid, creata: z.boolean() })

export const POST = withRoute('crm/ai/contatti:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'contatto')
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const { telefono, email, genitoreNome, origine, bambini = [] } = b.data
  const telefonoNorm = normalizzaTelefonoAi(telefono)
  if (telefonoNorm === null) {
    return chiudiChiamataAi(ai, rifiutoAi('CONTATTO_OBBLIGATORIO', 422), { codice: 'CONTATTO_OBBLIGATORIO' })
  }

  const supabase = await createAdminClient()
  const { data, error } = await supabase.rpc('crm_ai_registra_contatto', {
    p_scuola_id: ai.scuolaId,
    p_telefono: telefono,
    p_telefono_norm: telefonoNorm,
    p_email: email ?? null,
    p_email_norm: normalizzaEmail(email),
    p_genitore_nome: genitoreNome ?? null,
    p_origine: origine,
    p_bambini: bambini.map(({ nome, dataNascita }) => ({ nome: nome ?? null, data_nascita: dataNascita ?? null })),
  })
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), op))

  const esito = esitoRpcSchema.safeParse(data)
  if (!esito.success) {
    logErrore({ operazione: op, stato: 500 }, new Error('Esito inatteso da crm_ai_registra_contatto'))
    return chiudiChiamataAi(ai, rispostaCrmNonRiuscita(), { codice: 'CRM_OPERAZIONE_NON_RIUSCITA' })
  }

  const { scheda_id: schedaId, creata } = esito.data
  let visita: VisitaAi | null = null
  if (!creata) {
    const dettagli = await dettagliSchede(supabase, ai.scuolaId, [schedaId], new Date(), op)
    if ('response' in dettagli) return chiudiChiamataAi(ai, dettagli.response, { entitaId: schedaId })
    visita = dettagli.perScheda.get(schedaId)?.visita ?? null
  }
  logEvento('crm', 'info', {
    operazione: op, esito: creata ? 'ai-contatto-creato' : 'ai-contatto-gia-presente',
    scuola_id: ai.scuolaId, entita_id: schedaId,
  })
  return chiudiChiamataAi(ai, NextResponse.json({ schedaId, creata, visita }, { status: creata ? 201 : 200 }), { entitaId: schedaId })
})
