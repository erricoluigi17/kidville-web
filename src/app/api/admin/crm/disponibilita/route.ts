import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { resolveScuolaScrittura, resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { assertPersonaInScope, requireCrm } from '@/lib/crm/accesso'
import { puoToccareDi, soloLaPropria, zDurataVisitaMin } from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { DURATA_SLOT_DEFAULT_MIN, type DisponibilitaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zOraHHMM, zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · la settimana tipo di ciascuno (le fasce di disponibilità).
 *
 *  · `GET  /api/admin/crm/disponibilita?scuolaId[&utenteId]` — le fasce ancora valide della sede (quelle il cui
 *    `valida_al` non è passato) e `io`, cioè chi sta chiedendo: servono a «La mia disponibilità» per mostrarle;
 *  · `POST /api/admin/crm/disponibilita` — aggiunge una fascia: `giornoSettimana` 1 (lunedì) … 7 (domenica),
 *    `oraInizio`/`oraFine` come si leggono sull'orologio di Roma, `durataSlotMin` (default 45).
 *
 * Ognuna modifica la PROPRIA; l'admin quella di tutte (spec §9): una segreteria che scrive quella di una collega
 * prende `403 SOLO_LA_PROPRIA`. La persona passa comunque per `assertPersonaInScope` (anche l'admin: non si
 * assegna una fascia a chi non è di quella sede). La sede si dichiara (`scuolaId`) o, se l'utente ne ha una
 * sola, è quella; con più sedi e nessuna indicata è 400 — non si indovina.
 */

const getQuerySchema = z.object({ scuolaId: zUuid, utenteId: zUuid.optional() })

export const GET = withRoute('admin/crm/disponibilita:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null || scuole.length === 0) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/disponibilita:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const oggi = dataCivile(new Date())
  let query = supabase
    .from('crm_disponibilita')
    .select('*')
    .in('scuola_id', scuole)
    .or(`valida_al.is.null,valida_al.gte.${oggi}`)
  if (q.data.utenteId) query = query.eq('utente_id', q.data.utenteId)
  const { data, error } = await query.order('giorno_settimana', { ascending: true }).order('ora_inizio', { ascending: true })
  if (error) return rispostaErroreDb(error, 'admin/crm/disponibilita:GET')

  // `io` dice a chi guarda CHI È (id e ruolo letti dalla sessione, non dal client): la schermata «La mia
  // disponibilità» deve sapere di chi sono le fasce che mostra per prime e se può scegliere un'altra persona.
  return NextResponse.json({
    data: (data ?? []) as DisponibilitaRow[],
    io: { id: auth.user.id, ruolo: auth.user.role },
  })
})

const postSchema = z
  .object({
    scuolaId: zUuid.optional(),
    utenteId: zUuid.optional(),
    giornoSettimana: z.number().int().min(1).max(7),
    oraInizio: zOraHHMM,
    oraFine: zOraHHMM,
    durataSlotMin: zDurataVisitaMin.optional(),
    validaDal: zDataYMD.optional(),
    validaAl: zDataYMD.nullable().optional(),
  })
  .refine((b) => b.oraFine > b.oraInizio, { message: 'L’ora di fine deve seguire quella di inizio', path: ['oraFine'] })
  .refine((b) => !b.validaDal || !b.validaAl || b.validaAl >= b.validaDal, {
    message: 'La data finale precede quella iniziale',
    path: ['validaAl'],
  })

export const POST = withRoute('admin/crm/disponibilita:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response

  const utenteId = b.data.utenteId ?? auth.user.id
  if (!puoToccareDi(auth.user, utenteId)) return soloLaPropria()

  const supabase = await createAdminClient()
  const sede = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuolaId)
  if (sede.response || !sede.scuolaId) return sede.response ?? rifiutoSede('SEDE_NON_ACCESSIBILE')
  const scuolaId = sede.scuolaId

  const nonDellaSede = await assertPersonaInScope(supabase, utenteId, scuolaId)
  if (nonDellaSede) return nonDellaSede

  // `valida_dal` lo dà il server (oggi, a Roma) se manca: il default del database è `current_date`, cioè
  // il giorno di UTC, che dopo mezzanotte italiana è ancora «ieri».
  const validaDal = b.data.validaDal ?? dataCivile(new Date())
  if (b.data.validaAl && b.data.validaAl < validaDal) {
    return validationError([{ path: ['validaAl'], message: 'La data finale precede quella iniziale' }])
  }

  const { data, error } = await supabase
    .from('crm_disponibilita')
    .insert({
      scuola_id: scuolaId,
      utente_id: utenteId,
      giorno_settimana: b.data.giornoSettimana,
      ora_inizio: b.data.oraInizio,
      ora_fine: b.data.oraFine,
      durata_slot_min: b.data.durataSlotMin ?? DURATA_SLOT_DEFAULT_MIN,
      valida_dal: validaDal,
      valida_al: b.data.validaAl ?? null,
    })
    .select('id')
    .single()
  if (error || !data) return rispostaErroreDb(error ?? { message: 'inserimento senza riga di ritorno' }, 'admin/crm/disponibilita:POST')

  logEvento('crm', 'info', { operazione: 'admin/crm/disponibilita:POST', esito: 'disponibilita-creata', scuola_id: scuolaId, entita_id: data.id as string })
  return NextResponse.json({ id: data.id as string }, { status: 201 })
})
