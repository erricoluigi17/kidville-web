import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { assertPersonaInScope, assertSchedaInScope, personeDellaSede, requireCrm } from '@/lib/crm/accesso'
import {
  DURATA_VISITA_DEFAULT_MIN,
  fineDaDurata,
  istanteDaOrario,
  notificaVisitaAssegnata,
  visitaFuoriDisponibilita,
  zDurataVisitaMin,
  zOrarioVisita,
} from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { calcolaSlotLiberi, fuoriDisponibilita } from '@/lib/crm/slot'
import type { AppuntamentoRow, DisponibilitaRow, IndisponibilitaRow } from '@/lib/crm/tipi'
import { addGiorni } from '@/lib/format/data'
import { inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · le visite fissate.
 *
 *  · `GET  /api/admin/crm/appuntamenti?scuolaId&dal&al` — la settimana dell'agenda: le visite (con la
 *    famiglia, l'avviso «fuori disponibilità» e il segno «da chiudere»), gli slot liberi e le persone;
 *  · `POST /api/admin/crm/appuntamenti` — fissa una visita per una scheda e una persona.
 *
 * La sede della visita è quella della SCHEDA (verificata con `assertSchedaInScope`), non quella del cookie:
 * un'admin con due sedi che fissa su una scheda di Aversa mentre il selettore dice Giugliano scrive
 * comunque ad Aversa, perché la scheda è lì. Nel GET la sede si dichiara (`scuolaId`), mai si indovina.
 *
 * Il database impedisce la sovrapposizione (EXCLUDE su `assegnata_a` e `tstzrange(inizio, fine)` per le visite
 * `in_programma`): due segretarie che prendono lo stesso orario nello stesso istante producono una visita e un
 * `409 SLOT_OCCUPATO` (`23P01`). Gli slot NON vincolano la segretaria (spec §9): può fissare a qualsiasi ora,
 * e la risposta le dice se è `fuori_disponibilita`.
 */

/** L'agenda non serve intervalli lunghi: una settimana, un mese al più. Più di così è un errore di chi chiama. */
const GIORNI_MAX = 62

const querySchema = z
  .object({ scuolaId: zUuid, dal: zDataYMD, al: zDataYMD })
  .refine((q) => q.al >= q.dal, { message: 'La data finale precede quella iniziale', path: ['al'] })
  .refine((q) => q.al <= addGiorni(q.dal, GIORNI_MAX), { message: `L’intervallo non può superare ${GIORNI_MAX} giorni`, path: ['al'] })

export const GET = withRoute('admin/crm/appuntamenti:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null || scuole.length === 0) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/appuntamenti:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const { dal, al } = q.data
  // Estremo inferiore incluso, superiore ESCLUSO: l'inizio del giorno dopo `al`, a Roma.
  const da = inizioGiornoCivile(dal)
  const a = inizioGiornoCivile(addGiorni(al, 1))
  if (da === null || a === null) return validationError([{ path: ['dal'], message: 'Data non valida' }])

  const adesso = new Date()

  const [visite, disp, ass] = await Promise.all([
    supabase
      .from('crm_appuntamenti')
      .select('*')
      .in('scuola_id', scuole)
      .lt('inizio', a)
      .gt('fine', da)
      .neq('stato', 'annullato')
      .order('inizio', { ascending: true }),
    supabase
      .from('crm_disponibilita')
      .select('*')
      .in('scuola_id', scuole)
      .lte('valida_dal', al)
      .or(`valida_al.is.null,valida_al.gte.${dal}`),
    supabase.from('crm_indisponibilita').select('*').in('scuola_id', scuole).lt('dal', a).gt('al', da),
  ])
  if (visite.error) return rispostaErroreDb(visite.error, 'admin/crm/appuntamenti:GET:appuntamenti')
  if (disp.error) return rispostaErroreDb(disp.error, 'admin/crm/appuntamenti:GET:disponibilita')
  if (ass.error) return rispostaErroreDb(ass.error, 'admin/crm/appuntamenti:GET:indisponibilita')

  const appuntamenti = (visite.data ?? []) as AppuntamentoRow[]
  const disponibilita = (disp.data ?? []) as DisponibilitaRow[]
  const indisponibilita = (ass.data ?? []) as IndisponibilitaRow[]

  // Il nome della famiglia sta sulla scheda: una lettura sola per le schede della settimana.
  const schedaIds = [...new Set(appuntamenti.map((x) => x.scheda_id))]
  const nomi = new Map<string, string | null>()
  if (schedaIds.length > 0) {
    const schede = await supabase.from('crm_schede').select('id, genitore_nome').in('id', schedaIds).in('scuola_id', scuole)
    if (schede.error) return rispostaErroreDb(schede.error, 'admin/crm/appuntamenti:GET:schede')
    for (const s of schede.data ?? []) nomi.set(s.id as string, (s.genitore_nome as string | null) ?? null)
  }

  let persone
  try {
    persone = await personeDellaSede(supabase, scuole[0])
  } catch (err) {
    return rispostaErroreDb(err as { code?: string; message?: string }, 'admin/crm/appuntamenti:GET:persone')
  }

  // Gli slot li offrono solo le persone che oggi sono davvero della sede: la fascia di chi è stata
  // archiviata, o ha cambiato sede, non deve restare prenotabile.
  const dellaSede = new Set(persone.map((p) => p.id))
  const slot = calcolaSlotLiberi({
    disponibilita: disponibilita.filter((d) => dellaSede.has(d.utente_id)),
    indisponibilita,
    appuntamenti,
    dal,
    al,
    adesso,
  })

  return NextResponse.json({
    appuntamenti: appuntamenti.map((x) => {
      const inProgramma = x.stato === 'in_programma'
      return {
        ...x,
        scheda: { id: x.scheda_id, genitore_nome: nomi.get(x.scheda_id) ?? null },
        fuori_disponibilita: inProgramma ? fuoriDisponibilita(x, disponibilita, indisponibilita) : false,
        da_chiudere: inProgramma && Date.parse(x.fine) < adesso.getTime(),
      }
    }),
    slot,
    persone,
  })
})

const postSchema = z.object({
  schedaId: zUuid,
  inizio: zOrarioVisita,
  durataMin: zDurataVisitaMin.optional(),
  assegnataA: zUuid,
})

export const POST = withRoute('admin/crm/appuntamenti:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response

  const supabase = await createAdminClient()

  // La sede è quella della scheda. `assertSchedaInScope` risponde 404 se non c'è e 403 se è di un'altra sede.
  const gate = await assertSchedaInScope(supabase, auth.user, b.data.schedaId)
  if ('response' in gate) return gate.response
  const scuolaId = gate.scheda.scuola_id

  const nonDellaSede = await assertPersonaInScope(supabase, b.data.assegnataA, scuolaId)
  if (nonDellaSede) return nonDellaSede

  const inizio = istanteDaOrario(b.data.inizio)
  if (inizio === null) return validationError([{ path: ['inizio'], message: 'Data e ora non valide' }])
  const durata = b.data.durataMin ?? DURATA_VISITA_DEFAULT_MIN
  const fine = fineDaDurata(inizio, durata)

  const fuori = await visitaFuoriDisponibilita(supabase, {
    scuolaId,
    utenteId: b.data.assegnataA,
    inizio,
    fine,
    operazione: 'admin/crm/appuntamenti:POST',
  })
  if ('response' in fuori) return fuori.response

  const { data, error } = await supabase
    .from('crm_appuntamenti')
    .insert({
      scuola_id: scuolaId,
      scheda_id: gate.scheda.id,
      inizio,
      fine,
      durata_min: durata,
      assegnata_a: b.data.assegnataA,
      fissato_da: auth.user.id,
      fissato_via: 'segreteria',
      stato: 'in_programma',
    })
    .select('id')
    .single()
  // `23P01` (EXCLUDE) diventa 409 SLOT_OCCUPATO dentro `rispostaErroreDb`.
  if (error || !data) {
    return rispostaErroreDb(error ?? { message: 'inserimento senza riga di ritorno' }, 'admin/crm/appuntamenti:POST')
  }
  const id = data.id as string

  await registraEvento(supabase, {
    schedaId: gate.scheda.id,
    scuolaId,
    tipo: 'appuntamento_fissato',
    autore: auth.user.id,
    autoreVia: 'segreteria',
    dati: { appuntamento_id: id, inizio, durata_min: durata, assegnata_a: b.data.assegnataA },
  })

  // Per una collega: una notifica con SOLO giorno e ora. Per sé stessa non serve.
  if (b.data.assegnataA !== auth.user.id) {
    await notificaVisitaAssegnata(supabase, { scuolaId, appuntamentoId: id, inizio, destinatario: b.data.assegnataA })
  }

  return NextResponse.json({ id, fuori_disponibilita: fuori.fuori }, { status: 201 })
})
