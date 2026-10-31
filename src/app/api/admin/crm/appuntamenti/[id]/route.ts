import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { assertPersonaInScope, requireCrm } from '@/lib/crm/accesso'
import {
  assertSedeInScope,
  elementoNonTrovato,
  fineDaDurata,
  istanteDaOrario,
  notificaVisitaAssegnata,
  visitaFuoriDisponibilita,
  zDurataVisitaMin,
  zOrarioVisita,
} from '@/lib/crm/agenda'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { pianificaAzione, prossimaAzione } from '@/lib/crm/follow-up'
import type { AppuntamentoRow, StatoAppuntamento } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · una visita già fissata: spostarla, segnarla svolta, segnarla «non presentato»,
 * annullarla.
 *
 * `PATCH /api/admin/crm/appuntamenti/[id]` con `{ azione, … }`. Ogni azione parte SOLO da una visita
 * `in_programma`: una visita chiusa (svolta, non presentata, annullata) non si riapre da qui.
 *
 * ⚠️ FRA LA LETTURA E LA SCRITTURA UNA COLLEGA PUÒ AVER GIÀ CHIUSO LA VISITA. Per questo ogni `update` porta
 * `.eq('scuola_id')` E `.eq('stato','in_programma')`, e chiede indietro le righe colpite: se non ne torna
 * nessuna, la visita non era più in programma, si risponde `409 STATO_NON_AMMESSO` e NON si scrive né lo
 * storico né il richiamo successivo. Senza, la seconda delle due colleghe sovrascriverebbe la chiusura
 * della prima, e la catena dei follow-up nascerebbe due volte.
 *
 * Chi ha SVOLTO la visita (`svoltoDa`) non è per forza chi la SEGNA (`segnato_da`): la segreteria può
 * registrare per una collega. Il primo richiamo spetta a chi l'ha svolta, perché è lei che conosce la
 * famiglia; il «non presentato» invece non ha uno svolgitore, e il recupero va all'assegnataria.
 */

const patchSchema = z.discriminatedUnion('azione', [
  z.object({
    azione: z.literal('sposta'),
    inizio: zOrarioVisita,
    durataMin: zDurataVisitaMin.optional(),
    assegnataA: zUuid.optional(),
  }),
  z.object({ azione: z.literal('svolto'), svoltoDa: zUuid }),
  z.object({ azione: z.literal('non_presentato') }),
  z.object({ azione: z.literal('annulla') }),
])

const statoNonAmmesso = () =>
  NextResponse.json(
    { error: 'Questa visita non è più in programma: è già stata chiusa o annullata.', codice: 'STATO_NON_AMMESSO' },
    { status: 409 },
  )

/** Le sole colonne che cambiano alla chiusura di una visita (le altre restano com'erano). */
type Chiusura = Partial<Pick<AppuntamentoRow, 'stato' | 'svolto_da' | 'segnato_da' | 'segnato_il' | 'inizio' | 'fine' | 'durata_min' | 'assegnata_a'>>

/**
 * Scrive il cambio di stato SOLO se la visita è ancora `in_programma` e della sede giusta. `true` se la
 * riga è stata toccata; `false` se non c'era più niente da toccare (chiusa da una collega nel frattempo);
 * una risposta pronta se il database ha rifiutato (per esempio `23P01`, orario occupato, nello spostamento).
 */
async function aggiornaSeInProgramma(
  supabase: SupabaseClient,
  v: { id: string; scuolaId: string; campi: Chiusura; operazione: string },
): Promise<boolean | NextResponse> {
  const { data, error } = await supabase
    .from('crm_appuntamenti')
    .update({ ...v.campi, aggiornato_il: new Date().toISOString() })
    .eq('id', v.id)
    .eq('scuola_id', v.scuolaId)
    .eq('stato', 'in_programma' satisfies StatoAppuntamento)
    .select('id')
  if (error) return rispostaErroreDb(error, v.operazione)
  return (data ?? []).length > 0
}

export const PATCH = withRoute(
  'admin/crm/appuntamenti/[id]:PATCH',
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
    const operazione = `admin/crm/appuntamenti/[id]:PATCH:${b.data.azione}`

    const letta = await supabase.from('crm_appuntamenti').select('*').eq('id', id).maybeSingle()
    if (letta.error) return rispostaErroreDb(letta.error, `${operazione}:lettura`)
    if (!letta.data) return elementoNonTrovato()
    const visita = letta.data as AppuntamentoRow

    const fuoriSede = await assertSedeInScope(supabase, auth.user, visita.scuola_id, operazione)
    if (fuoriSede) return fuoriSede

    if (visita.stato !== 'in_programma') return statoNonAmmesso()

    const scuolaId = visita.scuola_id
    const autore = auth.user.id
    const adesso = new Date()
    const oggi = dataCivile(adesso)

    switch (b.data.azione) {
      case 'sposta': {
        const assegnataA = b.data.assegnataA ?? visita.assegnata_a
        const cambiaPersona = assegnataA !== visita.assegnata_a
        if (cambiaPersona) {
          const nonDellaSede = await assertPersonaInScope(supabase, assegnataA, scuolaId)
          if (nonDellaSede) return nonDellaSede
        }

        const inizio = istanteDaOrario(b.data.inizio)
        if (inizio === null) return validationError([{ path: ['inizio'], message: 'Data e ora non valide' }])
        const durata = b.data.durataMin ?? visita.durata_min
        const fine = fineDaDurata(inizio, durata)

        const cambiaOrario = Date.parse(inizio) !== Date.parse(visita.inizio) || durata !== visita.durata_min
        // Niente da cambiare: né una scrittura inutile né un evento che dice «spostata» di una visita ferma.
        if (!cambiaOrario && !cambiaPersona) return NextResponse.json({ id, invariato: true })

        const fuori = await visitaFuoriDisponibilita(supabase, { scuolaId, utenteId: assegnataA, inizio, fine, operazione })
        if ('response' in fuori) return fuori.response

        // 23P01 (la persona ha già un'altra visita in quell'orario) diventa 409 SLOT_OCCUPATO.
        const esito = await aggiornaSeInProgramma(supabase, {
          id,
          scuolaId,
          campi: { inizio, fine, durata_min: durata, assegnata_a: assegnataA },
          operazione,
        })
        if (esito instanceof NextResponse) return esito
        if (!esito) return statoNonAmmesso()

        if (cambiaOrario) {
          await registraEvento(supabase, {
            schedaId: visita.scheda_id,
            scuolaId,
            tipo: 'appuntamento_spostato',
            autore,
            autoreVia: 'segreteria',
            dati: { appuntamento_id: id, inizio_prima: visita.inizio, inizio_dopo: inizio, durata_min: durata },
          })
        }
        if (cambiaPersona) {
          await registraEvento(supabase, {
            schedaId: visita.scheda_id,
            scuolaId,
            tipo: 'appuntamento_riassegnato',
            autore,
            autoreVia: 'segreteria',
            dati: { appuntamento_id: id, assegnata_prima: visita.assegnata_a, assegnata_dopo: assegnataA },
          })
          // Avvisa chi la riceve — se non è la stessa che l'ha riassegnata. Giorno e ora, mai il nome.
          if (assegnataA !== autore) {
            await notificaVisitaAssegnata(supabase, { scuolaId, appuntamentoId: id, inizio, destinatario: assegnataA })
          }
        }
        return NextResponse.json({ id, fuori_disponibilita: fuori.fuori })
      }

      case 'svolto': {
        const svoltoDa = b.data.svoltoDa
        const nonDellaSede = await assertPersonaInScope(supabase, svoltoDa, scuolaId)
        if (nonDellaSede) return nonDellaSede

        const esito = await aggiornaSeInProgramma(supabase, {
          id,
          scuolaId,
          campi: { stato: 'svolto', svolto_da: svoltoDa, segnato_da: autore, segnato_il: adesso.toISOString() },
          operazione,
        })
        if (esito instanceof NextResponse) return esito
        if (!esito) return statoNonAmmesso()

        await registraEvento(supabase, {
          schedaId: visita.scheda_id,
          scuolaId,
          tipo: 'appuntamento_svolto',
          autore,
          autoreVia: 'segreteria',
          dati: { appuntamento_id: id, svolto_da: svoltoDa },
        })

        // Il primo richiamo spetta a chi ha svolto la visita, non a chi l'ha segnata. Se non si lascia
        // pianificare (database giù), `pianificaAzione` lo ha già registrato e la visita resta svolta.
        const prossima = prossimaAzione({ da: 'visita_svolta', oggi, giornoVisita: dataCivile(new Date(visita.inizio)) })
        const azione = prossima
          ? await pianificaAzione(supabase, {
              schedaId: visita.scheda_id,
              scuolaId,
              tipo: prossima.tipo,
              giorno: prossima.giorno,
              responsabile: svoltoDa,
              appuntamentoId: id,
              autore,
            })
          : null
        return NextResponse.json({ id, azione_id: azione?.id ?? null })
      }

      case 'non_presentato': {
        const esito = await aggiornaSeInProgramma(supabase, {
          id,
          scuolaId,
          campi: { stato: 'non_presentato', segnato_da: autore, segnato_il: adesso.toISOString() },
          operazione,
        })
        if (esito instanceof NextResponse) return esito
        if (!esito) return statoNonAmmesso()

        await registraEvento(supabase, {
          schedaId: visita.scheda_id,
          scuolaId,
          tipo: 'appuntamento_non_presentato',
          autore,
          autoreVia: 'segreteria',
          dati: { appuntamento_id: id },
        })

        // Il recupero (richiamare la famiglia che non è venuta) è di chi aspettava la visita.
        const prossima = prossimaAzione({ da: 'non_presentato', oggi })
        const azione = prossima
          ? await pianificaAzione(supabase, {
              schedaId: visita.scheda_id,
              scuolaId,
              tipo: prossima.tipo,
              giorno: prossima.giorno,
              responsabile: visita.assegnata_a,
              appuntamentoId: id,
              autore,
            })
          : null
        return NextResponse.json({ id, azione_id: azione?.id ?? null })
      }

      case 'annulla': {
        const esito = await aggiornaSeInProgramma(supabase, { id, scuolaId, campi: { stato: 'annullato' }, operazione })
        if (esito instanceof NextResponse) return esito
        if (!esito) return statoNonAmmesso()

        await registraEvento(supabase, {
          schedaId: visita.scheda_id,
          scuolaId,
          tipo: 'appuntamento_annullato',
          autore,
          autoreVia: 'segreteria',
          dati: { appuntamento_id: id },
        })
        return NextResponse.json({ id })
      }
    }
  },
)
