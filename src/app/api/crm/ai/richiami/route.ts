import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import {
  assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi,
} from '@/lib/crm/ai/accesso'
import { MOTIVI_PASSAGGIO } from '@/lib/crm/ai/richiami'
import { normalizzaTelefonoAi } from '@/lib/crm/ai/telefono'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import { ORIGINI, type ParametriRichiamoAi } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zOpzionale, zUuid } from '@/lib/validation/common'
import { parseBody } from '@/lib/validation/http'

const operazione = 'crm/ai:richiamo'
const campiComuni = { sede: zUuid, motivo: z.enum(MOTIVI_PASSAGGIO) }
const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const bodySchema = z.union([
  z.strictObject({ ...campiComuni, schedaId: zUuid }, campiAmmessi),
  z.strictObject({
    ...campiComuni,
    telefono: z.string().trim().min(6).max(40),
    genitoreNome: zOpzionale(z.string().trim().min(1).max(120)),
    origine: z.enum(ORIGINI),
  }, campiAmmessi),
])
const esitoRpcSchema = z.discriminatedUnion('esito', [
  z.object({ esito: z.literal('ok'), azione_id: zUuid, scheda_id: zUuid, creata: z.boolean() }),
  z.object({ esito: z.enum(['non_trovata', 'nessun_responsabile', 'token_non_valido']) }),
])

export const POST = withRoute('crm/ai/richiami:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'richiamo')
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const rifiuta = (codice: CodiceAi, stato: number) => chiudiChiamataAi(ai, rifiutoAi(codice, stato), { codice })
  let parametri: Omit<ParametriRichiamoAi, 'p_integrazione_id' | 'p_scuola_id' | 'p_motivo'>
  if ('schedaId' in b.data) {
    parametri = {
      p_scheda_id: b.data.schedaId.toLowerCase(),
      p_telefono: null,
      p_telefono_norm: null,
      p_genitore_nome: null,
      p_origine: null,
    }
  } else {
    const { telefono, origine, genitoreNome } = b.data
    const telefonoNorm = normalizzaTelefonoAi(telefono)
    if (telefonoNorm === null) return rifiuta('CONTATTO_OBBLIGATORIO', 422)
    parametri = {
      p_scheda_id: null,
      p_telefono: telefono,
      p_telefono_norm: telefonoNorm,
      p_genitore_nome: genitoreNome ?? null,
      p_origine: origine,
    }
  }

  // La RPC decide assegnazione e replay e salva il richiamo con i due eventi.
  const supabase = await createAdminClient()
  const { data, error } = await supabase.rpc('crm_ai_richiamo', {
    ...parametri,
    p_integrazione_id: ai.integrazioneId,
    p_scuola_id: ai.scuolaId,
    p_motivo: b.data.motivo,
  })
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione))

  const esito = esitoRpcSchema.safeParse(data)
  switch (esito.data?.esito) {
    case 'non_trovata':
      return rifiuta('SCHEDA_NON_TROVATA', 404)
    case 'nessun_responsabile':
      return rifiuta('NESSUN_RESPONSABILE', 409)
    case 'token_non_valido': {
      const risposta = rifiutoAi('TOKEN_NON_VALIDO', 401)
      risposta.headers.set('WWW-Authenticate', 'Bearer')
      return chiudiChiamataAi(ai, risposta, { codice: 'TOKEN_NON_VALIDO' })
    }
    case 'ok': {
      const { azione_id: azioneId, scheda_id: schedaId, creata } = esito.data
      if (parametri.p_scheda_id !== null && schedaId !== parametri.p_scheda_id) break
      if (creata) {
        logEvento('crm', 'info', {
          operazione, esito: 'ai-richiamo-in-lista', scuola_id: ai.scuolaId, entita_id: schedaId,
        })
      }
      return chiudiChiamataAi(ai,
        NextResponse.json({ azioneId, schedaId, creata }, { status: creata ? 201 : 200 }),
        { entitaId: schedaId })
    }
  }

  logEvento('crm', 'error', { operazione, esito: 'esito-illeggibile', scuola_id: ai.scuolaId })
  return rifiuta('CRM_OPERAZIONE_NON_RIUSCITA', 500)
})
