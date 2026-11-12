import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { correggiRigaPassaggio, ESITI_PASSAGGIO } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * CORREGGE A MANO LA RIGA DI UN BAMBINO nell'anteprima del passaggio (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno NUOVO.
 *
 * Si può cambiare la sezione nuova (`continua | cambia_grado | nuova`) oppure portare `continua | cambia_grado` a `esce`. Il resto
 * (`nuova → esce`, `esce | non_risposto → continua`) lo rifiuta il database con `RIGA_NON_VALIDA` (422): si fa da «Conferme».
 * Il passaggio lo trova il SERVER dall'anno dell'URL (il corpo non lo nomina: un corpo con `passaggio_id` è un 400), e `p_da` è
 * l'utente del token. Nei log: uuid, codici, numeri.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const putSchema = z
  .object({
    alunno_id: zUuid,
    /** Elenco chiuso. Le combinazioni non ammesse le rifiuta il database (422). */
    esito: z.enum(ESITI_PASSAGGIO),
    section_id: zUuid.nullable().optional(),
  })
  .strict()

export const PUT = withRoute('admin/anni/[annoSedeId]/passaggio/righe:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/righe:PUT'
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

  const esito = await correggiRigaPassaggio(supabase, {
    passaggioId: passaggio.passaggioId,
    alunnoId: corpo.alunno_id,
    esito: corpo.esito,
    sezioneId: corpo.section_id ?? null,
    da: auth.user.id,
  })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  // La porta non logga un successo per bambino: è un gesto. Lo scrive la route, con uuid, esito (elenco chiuso) e numeri.
  logEvento('anno-scolastico', 'info', {
    tipo: 'passaggio-riga-corretta',
    operazione,
    esito: esito.esito,
    n: 1,
    entita_id: passaggio.passaggioId,
    utente: auth.user.id,
  })
  return NextResponse.json({ success: true, data: { alunno_id: esito.alunno_id, esito: esito.esito, eccezione: esito.eccezione } })
})
