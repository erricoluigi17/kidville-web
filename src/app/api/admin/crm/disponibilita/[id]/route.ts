import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireCrm } from '@/lib/crm/accesso'
import { assertSedeInScope, elementoNonTrovato, puoToccareDi, soloLaPropria, zDurataVisitaMin } from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import type { DisponibilitaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zOraHHMM, zUuid } from '@/lib/validation/common'
import { parseBody, parseData, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · una fascia di disponibilità già scritta.
 *
 *  · `PATCH  /api/admin/crm/disponibilita/[id]` — cambia giorno, orari, durata dello slot o il periodo di validità;
 *  · `DELETE /api/admin/crm/disponibilita/[id]` — la toglie.
 *
 * Come nella creazione: ognuna tocca la PROPRIA fascia, l'admin quella di tutte (`403 SOLO_LA_PROPRIA`). La
 * sede della fascia è quella letta dal database, non una che arriva dal client: l'`update` e il `delete`
 * portano comunque `.eq('scuola_id')`.
 *
 * Togliere una fascia non tocca le visite già fissate: gli slot si ricalcolano ogni volta, e una visita che
 * resta fuori dalla disponibilità compare nell'agenda con l'avviso «fuori disponibilità».
 */

const patchSchema = z
  .object({
    giornoSettimana: z.number().int().min(1).max(7).optional(),
    oraInizio: zOraHHMM.optional(),
    oraFine: zOraHHMM.optional(),
    durataSlotMin: zDurataVisitaMin.optional(),
    validaDal: zDataYMD.optional(),
    validaAl: zDataYMD.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nessuna modifica richiesta' })

/** `HH:MM:SS` di Postgres → `HH:MM`, per confrontarlo con quello che arriva dal client. */
const hhmm = (ora: string) => ora.slice(0, 5)

export const PATCH = withRoute(
  'admin/crm/disponibilita/[id]:PATCH',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchSchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const operazione = 'admin/crm/disponibilita/[id]:PATCH'

    const letta = await supabase.from('crm_disponibilita').select('*').eq('id', id).maybeSingle()
    if (letta.error) return rispostaErroreDb(letta.error, `${operazione}:lettura`)
    if (!letta.data) return elementoNonTrovato()
    const fascia = letta.data as DisponibilitaRow

    const fuoriSede = await assertSedeInScope(supabase, auth.user, fascia.scuola_id, operazione)
    if (fuoriSede) return fuoriSede
    if (!puoToccareDi(auth.user, fascia.utente_id)) return soloLaPropria()

    // La fascia che ne risulta deve reggersi da sola: i CHECK del database (`ora_fine > ora_inizio`,
    // `valida_al >= valida_dal`) si controllano sul VALORE FINALE, non sulle sole cifre arrivate.
    const oraInizio = b.data.oraInizio ?? hhmm(fascia.ora_inizio)
    const oraFine = b.data.oraFine ?? hhmm(fascia.ora_fine)
    const validaDal = b.data.validaDal ?? fascia.valida_dal
    const validaAl = b.data.validaAl === undefined ? fascia.valida_al : b.data.validaAl
    if (oraFine <= oraInizio) return validationError([{ path: ['oraFine'], message: 'L’ora di fine deve seguire quella di inizio' }])
    if (validaAl !== null && validaAl < validaDal) {
      return validationError([{ path: ['validaAl'], message: 'La data finale precede quella iniziale' }])
    }

    const patch: Record<string, string | number | null> = {}
    if (b.data.giornoSettimana !== undefined) patch.giorno_settimana = b.data.giornoSettimana
    if (b.data.oraInizio !== undefined) patch.ora_inizio = b.data.oraInizio
    if (b.data.oraFine !== undefined) patch.ora_fine = b.data.oraFine
    if (b.data.durataSlotMin !== undefined) patch.durata_slot_min = b.data.durataSlotMin
    if (b.data.validaDal !== undefined) patch.valida_dal = b.data.validaDal
    if (b.data.validaAl !== undefined) patch.valida_al = b.data.validaAl

    const { data, error } = await supabase
      .from('crm_disponibilita')
      .update(patch)
      .eq('id', id)
      .eq('scuola_id', fascia.scuola_id)
      .select('id')
    if (error) return rispostaErroreDb(error, operazione)
    // La fascia è sparita fra la lettura e la scrittura (la collega l'ha appena tolta).
    if ((data ?? []).length === 0) return elementoNonTrovato()

    logEvento('crm', 'info', { operazione, esito: 'disponibilita-modificata', scuola_id: fascia.scuola_id, entita_id: id })
    return NextResponse.json({ id })
  },
)

export const DELETE = withRoute(
  'admin/crm/disponibilita/[id]:DELETE',
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const supabase = await createAdminClient()
    const operazione = 'admin/crm/disponibilita/[id]:DELETE'

    const letta = await supabase.from('crm_disponibilita').select('*').eq('id', id).maybeSingle()
    if (letta.error) return rispostaErroreDb(letta.error, `${operazione}:lettura`)
    if (!letta.data) return elementoNonTrovato()
    const fascia = letta.data as DisponibilitaRow

    const fuoriSede = await assertSedeInScope(supabase, auth.user, fascia.scuola_id, operazione)
    if (fuoriSede) return fuoriSede
    if (!puoToccareDi(auth.user, fascia.utente_id)) return soloLaPropria()

    const { data, error } = await supabase
      .from('crm_disponibilita')
      .delete()
      .eq('id', id)
      .eq('scuola_id', fascia.scuola_id)
      .select('id')
    if (error) return rispostaErroreDb(error, operazione)
    if ((data ?? []).length === 0) return elementoNonTrovato()

    logEvento('crm', 'info', { operazione, esito: 'disponibilita-eliminata', scuola_id: fascia.scuola_id, entita_id: id })
    return NextResponse.json({ id })
  },
)
