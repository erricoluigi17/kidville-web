import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveScuolaScrittura, resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { assertPersonaInScope, requireCrm } from '@/lib/crm/accesso'
import { istanteEstremoAssenza, puoToccareDi, soloLaPropria, zEstremoAssenza } from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { MOTIVI_INDISPONIBILITA, type IndisponibilitaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · le assenze (ferie, malattia, altro) e le chiusure di sede.
 *
 *  · `GET  /api/admin/crm/indisponibilita?scuolaId` — quelle non ancora finite, della sede;
 *  · `POST /api/admin/crm/indisponibilita` — ne aggiunge una: `{ scuolaId?, utenteId?, motivo, dal, al }`.
 *
 * `utenteId` assente = la propria assenza; `utenteId: null` = una CHIUSURA DI SEDE (`motivo: 'chiusura'`), che
 * può inserire qualsiasi segretaria della sede e che toglie gli slot di tutte. L'assenza di una collega la
 * inserisce solo l'admin (`403 SOLO_LA_PROPRIA`).
 *
 * `dal`/`al` accettano un GIORNO (`2026-11-03`) o un orario (`2026-11-03T09:00`, o un istante ISO). Con i
 * giorni, «al» è compreso: «dal 3 al 5» copre anche il 5 (vedi `istanteEstremoAssenza`).
 */

const getQuerySchema = z.object({ scuolaId: zUuid })

export const GET = withRoute('admin/crm/indisponibilita:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null || scuole.length === 0) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/indisponibilita:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  // Le assenze già finite non servono né all'agenda né all'elenco: restano nel database, non a schermo.
  const { data, error } = await supabase
    .from('crm_indisponibilita')
    .select('*')
    .in('scuola_id', scuole)
    .gt('al', new Date().toISOString())
    .order('dal', { ascending: true })
  if (error) return rispostaErroreDb(error, 'admin/crm/indisponibilita:GET')

  return NextResponse.json({ data: (data ?? []) as IndisponibilitaRow[] })
})

const postSchema = z
  .object({
    scuolaId: zUuid.optional(),
    utenteId: zUuid.nullable().optional(),
    motivo: z.enum(MOTIVI_INDISPONIBILITA),
    dal: zEstremoAssenza,
    al: zEstremoAssenza,
  })
  .refine((b) => b.utenteId !== null || b.motivo === 'chiusura', {
    message: 'Una assenza di tutta la sede è una chiusura',
    path: ['motivo'],
  })

export const POST = withRoute('admin/crm/indisponibilita:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response

  // `null` esplicito = la sede; assente = la propria.
  const chiusuraDiSede = b.data.utenteId === null
  const utenteId = chiusuraDiSede ? null : (b.data.utenteId ?? auth.user.id)
  if (utenteId !== null && !puoToccareDi(auth.user, utenteId)) return soloLaPropria()

  const dal = istanteEstremoAssenza(b.data.dal, 'dal')
  const al = istanteEstremoAssenza(b.data.al, 'al')
  if (dal === null) return validationError([{ path: ['dal'], message: 'Data non valida' }])
  if (al === null) return validationError([{ path: ['al'], message: 'Data non valida' }])
  if (Date.parse(al) <= Date.parse(dal)) {
    return validationError([{ path: ['al'], message: 'La fine deve seguire l’inizio' }])
  }

  const supabase = await createAdminClient()
  const sede = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuolaId)
  if (sede.response || !sede.scuolaId) return sede.response ?? rifiutoSede('SEDE_NON_ACCESSIBILE')
  const scuolaId = sede.scuolaId

  if (utenteId !== null) {
    const nonDellaSede = await assertPersonaInScope(supabase, utenteId, scuolaId)
    if (nonDellaSede) return nonDellaSede
  }

  const { data, error } = await supabase
    .from('crm_indisponibilita')
    .insert({ scuola_id: scuolaId, utente_id: utenteId, dal, al, motivo: b.data.motivo, creata_da: auth.user.id })
    .select('id')
    .single()
  if (error || !data) return rispostaErroreDb(error ?? { message: 'inserimento senza riga di ritorno' }, 'admin/crm/indisponibilita:POST')

  logEvento('crm', 'info', {
    operazione: 'admin/crm/indisponibilita:POST',
    esito: chiusuraDiSede ? 'chiusura-di-sede-creata' : 'assenza-creata',
    scuola_id: scuolaId,
    entita_id: data.id as string,
  })
  return NextResponse.json({ id: data.id as string }, { status: 201 })
})
