import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  impostazioniNonDisponibili,
  rispostaErroreImpostazioni,
} from '@/lib/anno/impostazioni'
import { MOTIVI_NON_RINNOVA, segnaNonRinnova } from '@/lib/anno/iscrizione-anno'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * IL «NON RINNOVA» (PR 4.5, compito 4.5.6): la famiglia dice che l'anno prossimo il bambino non c'è. Si scrive sulla frequenza
 * di PARTENZA (`anno_non_rinnova`): un motivo dell'elenco chiuso, mai testo libero. `annoSedeId` = l'anno NUOVO, come per le
 * conferme; tutte e due le sedi (quella dell'anno e quella della frequenza) devono essere dell'utente.
 * La conferma resta possibile dopo (la famiglia cambia idea): «non rinnova» non la blocca e non la cancella.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const

/** `motivo` è un codice dell'elenco chiuso o niente. Un testo qualunque è un 400: non arriva nemmeno al database. */
const postSchema = z
  .object({
    frequenza_id: zUuid,
    attivo: z.boolean(),
    motivo: z.enum(MOTIVI_NON_RINNOVA).nullable().optional(),
  })
  .strict()

export const POST = withRoute('admin/anni/[annoSedeId]/conferme/non-rinnova:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/conferme/non-rinnova:POST'
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

  const partenza = await supabase.from('frequenze').select('id, anno_sede_id').eq('id', corpo.frequenza_id).maybeSingle()
  if (partenza.error) return rispostaErroreImpostazioni(partenza.error, { ...ctx, lettura: true })
  const annoPartenza = (partenza.data as { anno_sede_id?: string } | null)?.anno_sede_id
  if (!annoPartenza) return rispostaErroreImpostazioni({ message: 'PARAMETRO_MANCANTE' }, ctx)
  const fuoriSedePartenza = await assertAnnoSedeInScope(supabase, auth.user, annoPartenza, operazione)
  if (fuoriSedePartenza) return fuoriSedePartenza

  const esito = await segnaNonRinnova(supabase, {
    frequenzaId: corpo.frequenza_id,
    attivo: corpo.attivo,
    motivo: corpo.motivo ?? null,
    da: auth.user.id,
  })
  if (!esito.ok) return rispostaErroreImpostazioni({ message: esito.codice }, ctx)
  if ('saltata' in esito) return impostazioniNonDisponibili({ code: 'PGRST202' }, operazione)

  // Il successo l'ha già scritto la porta (`non-rinnova-registrato`): uuid, esito e il codice del motivo.
  return NextResponse.json({
    success: true,
    data: { frequenza_id: esito.frequenza_id, non_rinnova: esito.non_rinnova, cambiato: esito.cambiato },
  })
})
