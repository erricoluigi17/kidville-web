import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  logConfineSpostato,
  logDateImpostate,
  logDomandeImpostate,
  risultatoScrittura,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * Le impostazioni di UN anno di UNA sede (`annoSedeId` = `anni_sede.id`).
 *
 * La REGOLA sta nelle funzioni SQL (`anno_impostazioni_sede.sql`): qui si giudicano chi chiede (Direzione e
 * segreteria) e per quale sede, si valida il corpo, si chiama la funzione e si traduce il suo rifiuto
 * (`src/lib/anno/impostazioni.ts`). Lo STATO dell'anno non si scrive da qui: le uniche transizioni sono
 * «apri le iscrizioni» (route a parte) e quelle del passaggio d'anno. `scuola_id` non è un campo del corpo:
 * la sede è quella della riga.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const

/**
 * GET — che cosa manca per aprire le iscrizioni, PRIMA del clic su «Apri le iscrizioni».
 * `{ success: true, data: { mancano: ['quota_conferma', …] } }`, `[]` = pronto.
 */
export const GET = withRoute('admin/anni/[annoSedeId]:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const { annoSedeId: grezzo } = await context.params
  const operazione = 'admin/anni/[annoSedeId]:GET'

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase.rpc('anno_prerequisiti_iscrizioni', { p_anno_sede: annoSedeId })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
      lettura: true,
    })
  }
  const mancano = Array.isArray(data) ? data.filter((m): m is string => typeof m === 'string') : null
  if (!mancano) return rispostaNonRiconosciuta(operazione)
  return NextResponse.json({ success: true, data: { mancano } })
})

/**
 * Il corpo: UNA azione per volta, `strict` (un campo in più è un 400: né lo stato né la sede si scrivono da qui).
 * `date`: i due campi sono opzionali, assente = non toccare. `zDataYMD` rifiuta anche `2026-02-30`.
 */
const patchSchema = z.discriminatedUnion('azione', [
  z.object({ azione: z.literal('confine'), nuova_fine: zDataYMD }).strict(),
  z
    .object({
      azione: z.literal('date'),
      ultimo_giorno_aperto: zDataYMD.optional(),
      prepara_successivo_dal: zDataYMD.optional(),
    })
    .strict(),
  z.object({ azione: z.literal('domande'), aperte: z.boolean() }).strict(),
])

/** PATCH — sposta il confine con l'anno dopo, imposta le due date dell'anno, apre o chiude le domande dal sito. */
export const PATCH = withRoute('admin/anni/[annoSedeId]:PATCH', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, patchSchema)
  if ('response' in b) return b.response
  const corpo = b.data
  const operazione = `admin/anni/[annoSedeId]:PATCH:${corpo.azione}`

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const chi = { utente: auth.user.id, annoSedeId }

  const { data, error } =
    corpo.azione === 'confine'
      ? await supabase.rpc('sposta_confine_anno', { p_anno_sede: annoSedeId, p_nuova_fine: corpo.nuova_fine })
      : corpo.azione === 'date'
        ? await supabase.rpc('anno_imposta_date', {
            p_anno_sede: annoSedeId,
            p_ultimo_giorno_aperto: corpo.ultimo_giorno_aperto ?? null,
            p_prepara_successivo_dal: corpo.prepara_successivo_dal ?? null,
          })
        : await supabase.rpc('anno_imposta_domande', { p_anno_sede: annoSedeId, p_aperte: corpo.aperte })

  if (error) {
    return rispostaErroreImpostazioni(error, {
      ...chi,
      operazione,
      tipoRifiuto: 'anno-domande-rifiutate',
      aperte: corpo.azione === 'domande' ? corpo.aperte : undefined,
    })
  }
  const r = risultatoScrittura(data)
  if (!r) return rispostaNonRiconosciuta(operazione)

  // Il successo si scrive solo se qualcosa è cambiato: «salvare senza cambiare» non è un evento.
  if (r.cambiato) {
    if (corpo.azione === 'confine') logConfineSpostato(chi, r)
    else if (corpo.azione === 'date') logDateImpostate(chi, r)
    else logDomandeImpostate(chi, corpo.aperte)
  }
  return NextResponse.json({ success: true, data: r })
})
