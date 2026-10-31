import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { withRoute } from '@/lib/logging/with-route'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · una nota o una telefonata nello storico di una scheda.
 *
 * `POST /api/admin/crm/schede/[id]/eventi` con `{ tipo: 'nota' | 'telefonata', testo }` → `201 { ok: true }`.
 *
 * È l'UNICO punto in cui lo storico riceve testo libero scritto da una persona, e per questo i tipi
 * ammessi sono due: tutti gli altri eventi (esito cambiato, visita fissata, richiamo fatto…) li scrive il
 * gesto che li produce, mai un client che dichiara di averli fatti.
 *
 * Qui la scrittura dello storico NON è «un di più»: la nota È il gesto. Se non si scrive, la risposta è
 * un errore — rispondere 201 e perdere ciò che la segreteria ha appena digitato sarebbe peggio.
 * `registraEvento` non lancia e non porta il testo nel log; il testo non viene mai loggato da qui.
 */

const OPERAZIONE = 'admin/crm/schede/[id]/eventi:POST'

const postBodySchema = z.object({
  tipo: z.enum(['nota', 'telefonata']),
  testo: z.string().trim().min(1).max(2000),
})

export const POST = withRoute('admin/crm/schede/[id]/eventi:POST', async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const idP = parseData(zUuid, (await context.params).id)
  if ('response' in idP) return idP.response
  const body = await parseBody(request, postBodySchema)
  if ('response' in body) return body.response

  const supabase = await createAdminClient()
  const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
  if ('response' in ambito) return ambito.response

  const scritto = await registraEvento(supabase, {
    schedaId: ambito.scheda.id,
    scuolaId: ambito.scheda.scuola_id,
    tipo: body.data.tipo,
    autore: auth.user.id,
    autoreVia: 'segreteria',
    testo: body.data.testo,
  })
  // Il perché è già nel log (`registraEvento` lo ha scritto, con il codice del database).
  if (!scritto) return rispostaErroreDb({ code: 'evento-non-registrato' }, OPERAZIONE)

  return NextResponse.json({ ok: true }, { status: 201 })
})
