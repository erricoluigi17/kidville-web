import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  risultatoScrittura,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * I POSTI AUTORIZZATI dell'anno che si sta preparando, per fascia. Sono un'indicazione: superarli non blocca mai
 * un'iscrizione. La regola (anno in preparazione o aperto, posti ≥ 0) sta in `anno_posti_imposta` (M45d).
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const FASCE = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'] as const

type RigaPosti = { fascia: string; posti: number; fonte: string | null }

/** GET — i posti dell'anno, per fascia. `{ success: true, data: { posti: [...] } }`. */
export const GET = withRoute('admin/anni/[annoSedeId]/posti:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/posti:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase
    .from('posti_autorizzati')
    .select('fascia, posti, fonte')
    .eq('anno_sede_id', annoSedeId)
    .order('fascia', { ascending: true })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
      lettura: true,
    })
  }
  return NextResponse.json({ success: true, data: { posti: (Array.isArray(data) ? data : []) as RigaPosti[] } })
})

/** `posti: null` toglie la fascia (non è più offerta). `fonte` è il riferimento dell'autorizzazione, non un dato personale. */
const putSchema = z
  .object({
    fascia: z.enum(FASCE),
    posti: z.number().int().min(0).max(100000).nullable(),
    fonte: z.string().trim().max(200).nullable().optional(),
  })
  .strict()

/** PUT — imposta (o toglie) i posti di una fascia. */
export const PUT = withRoute('admin/anni/[annoSedeId]/posti:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/posti:PUT'
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

  const { data, error } = await supabase.rpc('anno_posti_imposta', {
    p_anno_sede: annoSedeId,
    p_fascia: corpo.fascia,
    p_posti: corpo.posti,
    p_fonte: corpo.fonte ?? null,
  })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
    })
  }
  const r = risultatoScrittura(data)
  if (!r) return rispostaNonRiconosciuta(operazione)

  if (r.cambiato) {
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-posti-impostati',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_tipo: corpo.fascia,
      n: corpo.posti ?? 0,
      rimossa: corpo.posti === null,
    })
  }
  return NextResponse.json({ success: true, data: r })
})
