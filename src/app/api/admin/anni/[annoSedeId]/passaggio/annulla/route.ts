import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { annullaPassaggio } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * ANNULLA IL PASSAGGIO D'ANNO (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno NUOVO. Finché nel nuovo anno non c'è ancora niente
 * d'uso, rimette le cose com'erano (uscite, ritirati, docenti, stati dei due anni); altrimenti `PASSAGGIO_NON_ANNULLABILE` (409) con
 * `conteggi` = quante righe d'uso per tabella. Le copie didattiche restano. Rifatta su un passaggio già annullato: 200.
 *
 * Il corpo è VUOTO e `strict`: nessun `oggi` dal client; il passaggio lo trova il server; `p_da` è l'utente del token.
 * Il successo lo scrive la porta (`passaggio-annullato`).
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const postSchema = z.object({}).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/passaggio/annulla:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/annulla:POST'
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

  const esito = await annullaPassaggio(supabase, { passaggioId: passaggio.passaggioId, da: auth.user.id })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  return NextResponse.json({
    success: true,
    data: {
      passaggio_id: esito.passaggio_id,
      gia_annullato: esito.gia_annullato === true,
      conteggi: esito.conteggi ?? {},
    },
  })
})
