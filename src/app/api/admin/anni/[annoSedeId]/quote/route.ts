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
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * Le QUOTE dell'anno che si sta preparando (`annoSedeId` = `anni_sede.id`): la quota di conferma e quella di nuova
 * iscrizione, per fascia o per tutte, con la scadenza. La regola (anno in preparazione o aperto, importo > 0) sta in
 * `anno_listino_quota_imposta` (M45d); qui si giudicano chi chiede e per quale sede, si valida il corpo e si traduce il
 * rifiuto. Nessun importo è scritto nel codice: lo decide la segreteria.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const FASCE = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'] as const

type RigaListino = { voce: string; fascia: string | null; importo: number | null; scadenza: string | null }

/**
 * GET — le due quote dell'anno e, in SOLA LETTURA, le righe `retta` e `servizio` del listino (le scrive la 4.6).
 * `{ success: true, data: { quote: [...], listino: [...] } }`.
 */
export const GET = withRoute('admin/anni/[annoSedeId]/quote:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/quote:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase
    .from('listino_voci')
    .select('voce, fascia, importo, scadenza')
    .eq('anno_sede_id', annoSedeId)
    .order('voce', { ascending: true })
    .order('fascia', { ascending: true, nullsFirst: true })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
      lettura: true,
    })
  }
  const righe = (Array.isArray(data) ? data : []) as RigaListino[]
  const quote = righe.filter((r) => r.voce === 'quota_conferma' || r.voce === 'quota_nuova')
  const listino = righe
    .filter((r) => r.voce === 'retta' || r.voce === 'servizio')
    .map((r) => ({ voce: r.voce, fascia: r.fascia, importo: r.importo }))
  return NextResponse.json({ success: true, data: { quote, listino } })
})

/**
 * Il corpo: UNA quota per volta, `strict`. `fascia: null` = per tutte le fasce; `importo: null` toglie la riga;
 * `scadenza: null` = «trenta giorni da quando nasce la voce». L'importo è un NUMERO (una stringa è un 400): se è
 * positivo lo giudica il database, che risponde `IMPORTO_NON_VALIDO` (422).
 */
const putSchema = z
  .object({
    voce: z.enum(['quota_conferma', 'quota_nuova']),
    fascia: z.enum(FASCE).nullable().optional(),
    importo: z.number().finite().nullable(),
    scadenza: zDataYMD.nullable().optional(),
  })
  .strict()

/** PUT — imposta (o toglie) la quota nominata. */
export const PUT = withRoute('admin/anni/[annoSedeId]/quote:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/quote:PUT'
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

  const { data, error } = await supabase.rpc('anno_listino_quota_imposta', {
    p_anno_sede: annoSedeId,
    p_voce: corpo.voce,
    p_fascia: corpo.fascia ?? null,
    p_importo: corpo.importo,
    p_scadenza: corpo.scadenza ?? null,
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

  // Il successo si scrive solo se qualcosa è cambiato. Niente importo, niente scadenza: sono uuid, un codice e un flag.
  if (r.cambiato) {
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-quota-impostata',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_tipo: corpo.voce,
      rimossa: corpo.importo === null,
    })
  }
  return NextResponse.json({ success: true, data: r })
})
