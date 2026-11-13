import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { confermaPassaggio } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * CONFERMA IL PASSAGGIO D'ANNO (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno NUOVO. È il gesto che cambia l'anno attivo della sede:
 * chi non ha risposto esce, chi continua passa alla classe nuova, i docenti si copiano. Una sola transazione nel database.
 *
 * Il corpo è VUOTO e `strict`: il passaggio lo trova il server dall'anno dell'URL, `p_da` è l'utente del token e il giorno «oggi» è
 * quello di Roma deciso dal database (un `oggi` dal client è un 400: serve solo alle prove, e solo sulle sedi di prova).
 * Il database rifiuta con `PASSAGGIO_TROPPO_PRESTO`, `PASSAGGIO_NON_PRONTO`, `ANTEPRIMA_VECCHIA`, `RIGHE_DA_DECIDERE` (con i
 * conteggi). Rifatta su un passaggio già confermato: 200 con `gia_confermato`. Il successo lo scrive la porta (`passaggio-confermato`).
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const postSchema = z.object({}).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/passaggio/conferma:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/conferma:POST'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  const passaggio = await passaggioDellAnno(supabase, annoSedeId, ctx)
  if ('response' in passaggio) return passaggio.response

  const esito = await confermaPassaggio(supabase, { passaggioId: passaggio.passaggioId, da: auth.user.id })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  return NextResponse.json({
    success: true,
    data: { passaggio_id: esito.passaggio_id, gia_confermato: esito.gia_confermato, conteggi: esito.conteggi },
  })
})
