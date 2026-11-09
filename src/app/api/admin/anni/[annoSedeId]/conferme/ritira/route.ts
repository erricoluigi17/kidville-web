import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, impostazioniNonDisponibili, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { ritiraConferma } from '@/lib/anno/iscrizione-anno'
import { rispostaFrequenzaNonTrovata } from '@/lib/anno/errori'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * «RITIRA LA CONFERMA» (PR 4.5, compito 4.5.15, C1): la famiglia aveva confermato e ci ripensa, oppure la segreteria ha
 * sbagliato bambino. `annoSedeId` = l'anno NUOVO; `frequenza_id` = la frequenza di quell'anno nata da una conferma.
 *
 * La frequenza passa a `ritirato`; la voce della quota si toglie SOLO se la contabilità lo permette (le guardie
 * dell'eliminazione di una voce, `controllaVoceEliminabile`): una voce con incassi o fatture resta, e la risposta lo dice
 * (`quota: 'resta-pagata'`). Nessun rimborso automatico. Dopo si può dire «Non rinnova» o rifare «Conferma».
 *
 * SOLO `admin` e `segreteria`, come l'eliminazione di una voce: toglie soldi dalla contabilità. La coordinatrice riceve 403.
 */
const STAFF = ['admin', 'segreteria'] as const

const postSchema = z.object({ frequenza_id: zUuid }).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/conferme/ritira:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/conferme/ritira:POST'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response
  const corpo = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: 'anno-iscrizioni-rifiutate' as const }

  // La frequenza dev'essere di QUESTO anno: l'URL nomina l'anno di cui si è verificata la sede, il corpo non può nominarne un altro.
  const riga = await supabase.from('frequenze').select('id, anno_sede_id').eq('id', corpo.frequenza_id).maybeSingle()
  if (riga.error) return rispostaErroreImpostazioni(riga.error, { ...ctx, lettura: true })
  const trovata = riga.data as { id: string; anno_sede_id: string } | null
  if (!trovata || trovata.anno_sede_id !== annoSedeId) return rispostaFrequenzaNonTrovata()

  const esito = await ritiraConferma(supabase, { frequenzaId: corpo.frequenza_id, attore: auth.user })
  if (!esito.ok) return rispostaErroreImpostazioni({ message: esito.codice }, ctx)
  if ('saltata' in esito) return impostazioniNonDisponibili({ code: 'PGRST202' }, operazione)

  // Il successo l'ha già scritto la porta (`conferma-ritirata`): uuid, esito e booleani.
  return NextResponse.json({
    success: true,
    data: { frequenza_id: esito.frequenza_id, ritirata: esito.ritirata, quota: esito.quota },
  })
})
