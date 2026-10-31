import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { ANNI_INGRESSO } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { zDataYMD, zOpzionale, zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · un altro bambino nella scheda di una famiglia.
 *
 * `POST /api/admin/crm/schede/[id]/bambini` → `201 { id }`. Il bambino nasce «aperto» (il predefinito del
 * database) nella sede della scheda. Nello storico entra `bambino_aggiunto` con il solo id: il nome di un
 * minore non va nei log né nelle righe di servizio.
 */

const OPERAZIONE = 'admin/crm/schede/[id]/bambini:POST'

const postBodySchema = z.object({
  nome: z.string().trim().min(1).max(100),
  dataNascita: zOpzionale(zDataYMD),
  annoIngresso: z.enum(ANNI_INGRESSO),
})

export const POST = withRoute('admin/crm/schede/[id]/bambini:POST', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const idP = parseData(zUuid, (await context.params).id)
  if ('response' in idP) return idP.response
  const body = await parseBody(request, postBodySchema)
  if ('response' in body) return body.response

  const supabase = await createAdminClient()
  const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
  if ('response' in ambito) return ambito.response
  const { id: schedaId, scuola_id: scuolaId } = ambito.scheda

  const { data, error } = await supabase
    .from('crm_bambini')
    .insert({
      scuola_id: scuolaId,
      scheda_id: schedaId,
      nome: body.data.nome,
      data_nascita: body.data.dataNascita ?? null,
      anno_ingresso: body.data.annoIngresso,
    })
    .select('id')
    .single()
  if (error || !data) return rispostaErroreDb(error ?? {}, OPERAZIONE)
  const bambinoId = data.id as string

  await registraEvento(supabase, {
    schedaId,
    scuolaId,
    tipo: 'bambino_aggiunto',
    autore: auth.user.id,
    autoreVia: 'segreteria',
    dati: { bambino_id: bambinoId },
  })

  return NextResponse.json({ id: bambinoId }, { status: 201 })
})
