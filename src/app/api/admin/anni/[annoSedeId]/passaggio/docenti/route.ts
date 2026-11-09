import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { impostaDocentePassaggio } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * AGGIUNGE O TOGLIE UN DOCENTE da una sezione nuova, nell'anteprima del passaggio (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno
 * NUOVO. `origine`: `aggiunta` mette il docente sulla sezione (e ripristina una `tolta`); `tolta` lo toglie (a una `copiata` la
 * marca, non la cancella). Il passaggio dev'essere ancora in anteprima (`PASSAGGIO_NON_MODIFICABILE`, 409).
 * Il passaggio lo trova il SERVER dall'anno dell'URL; `p_da` è l'utente del token. Nei log: uuid, codici, numeri.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const putSchema = z
  .object({
    utente_id: zUuid,
    section_id: zUuid,
    /** Elenco chiuso: `copiata` la scrive solo il calcolo dell'anteprima. */
    origine: z.enum(['aggiunta', 'tolta']),
  })
  .strict()

export const PUT = withRoute('admin/anni/[annoSedeId]/passaggio/docenti:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/docenti:PUT'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, putSchema)
  if ('response' in b) return b.response
  const corpo = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  const passaggio = await passaggioDellAnno(supabase, annoSedeId, ctx)
  if ('response' in passaggio) return passaggio.response

  const esito = await impostaDocentePassaggio(supabase, {
    passaggioId: passaggio.passaggioId,
    utenteId: corpo.utente_id,
    sezioneId: corpo.section_id,
    origine: corpo.origine,
    da: auth.user.id,
  })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  logEvento('anno-scolastico', 'info', {
    tipo: 'passaggio-docente-impostato',
    operazione,
    esito: corpo.origine,
    n: 1,
    entita_id: passaggio.passaggioId,
    utente: auth.user.id,
  })
  return NextResponse.json({
    success: true,
    data: { utente_id: esito.utente_id ?? corpo.utente_id, sezione_a_id: esito.sezione_a_id ?? corpo.section_id, origine: esito.origine ?? corpo.origine },
  })
})
