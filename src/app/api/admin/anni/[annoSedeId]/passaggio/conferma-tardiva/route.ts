import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { confermaTardiva } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * CONFERMA TARDIVA (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno NUOVO, già `corrente`. La famiglia che aveva detto «no» (o non
 * aveva risposto) e quindi è uscita nel passaggio ora conferma: nasce la sua frequenza nel nuovo anno, con la quota. Solo se il
 * passaggio è `confermato` e la riga è `esce | non_risposto`. `section_id` assente = la continuazione della sezione di partenza.
 * Rifatta: `creata: false`. Il passaggio lo trova il server; `p_da` è l'utente del token; nessun `oggi` dal client.
 * Il successo lo scrive la porta (`passaggio-conferma-tardiva`).
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const postSchema = z.object({ alunno_id: zUuid, section_id: zUuid.nullable().optional() }).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/passaggio/conferma-tardiva:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/conferma-tardiva:POST'
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
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  const passaggio = await passaggioDellAnno(supabase, annoSedeId, ctx)
  if ('response' in passaggio) return passaggio.response

  const esito = await confermaTardiva(supabase, {
    passaggioId: passaggio.passaggioId,
    alunnoId: corpo.alunno_id,
    sectionId: corpo.section_id ?? null,
    da: auth.user.id,
  })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  return NextResponse.json({
    success: true,
    data: {
      frequenza_id: esito.frequenza_id,
      creata: esito.creata,
      quota: esito.quota ?? null,
      pagamento_id: esito.pagamento_id ?? null,
    },
  })
})
