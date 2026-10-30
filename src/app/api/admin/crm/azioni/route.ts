import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { assertPersonaInScope, assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { pianificaAzione } from '@/lib/crm/follow-up'
import type { AzioneRow } from '@/lib/crm/tipi'
import { dataCivile } from '@/i18n/config'
import { fineGiornoCivile } from '@/lib/format/confini-giorno'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseQuery, validationError } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · i richiami da fare.
 *
 * ── GET /api/admin/crm/azioni?scuolaId&responsabile?&finoA? ───────────────────────────────────────────────
 * Le azioni APERTE (né fatte né cancellate) di UNA sede, con scadenza fino alla fine del giorno `finoA`
 * (di default oggi), in ordine di scadenza: le scadute in cima. Ogni azione porta `scheda` (id, nome del
 * genitore, primo telefono: quanto basta per chiamare, niente altro) e `in_ritardo`.
 *
 * ⚠️ OGGI E «IN RITARDO» SONO GIORNI DI ROMA. Su Vercel il processo gira in UTC e chi usa l'app sta in
 * Italia: «fino a oggi» come `${oggi}T23:59:59Z` farebbe entrare anche i richiami di domani mattina presto
 * (le 00:30 di Roma sono le 22:30/23:30 UTC di oggi), e «scaduta» come `scadenza < adesso` metterebbe in
 * ritardo un richiamo delle 10:30 alle 10:31 dello stesso giorno. Il confine superiore è
 * `fineGiornoCivile(finoA)`; il ritardo è «il giorno di Roma della scadenza è PRIMA del giorno di Roma di
 * oggi» (la metrica dei follow-up in tempo, spec §10, si misura sul giorno di scadenza).
 *
 * La sede si DICHIARA (`scuolaId` obbligatorio) e deve stare fra le attive dell'utente: `restringiSedi`,
 * come `persone`. Una sede non propria è un 403, non un elenco vuoto.
 *
 * ── POST /api/admin/crm/azioni ─────────────────────────────────────────────────────────────────────────────
 * `{ schedaId, giorno, responsabile }` → crea un «richiamare» a mano alle 10:30 di Roma di `giorno`.
 * La scheda deve essere di una sede dell'utente (`assertSchedaInScope`), il responsabile una persona di
 * segreteria/Direzione di QUELLA sede (`assertPersonaInScope`, 422 altrimenti). La scrittura la fa
 * `pianificaAzione`, la stessa della catena: stessa scadenza alle 10:30, stessa voce nello storico.
 *
 * `ora` NON è ammessa (il corpo è `strict`: un campo in più è un 400, non un valore ignorato in silenzio).
 * Il piano la prevedeva, ma `pianificaAzione` fissa la scadenza alle 10:30 e non ha un parametro per l'ora:
 * per cambiarla c'è «sposta» (`PATCH …/[id]`), che accetta l'ora.
 */

const getQuerySchema = z.object({
  scuolaId: zUuid,
  responsabile: zUuid.optional(),
  finoA: zDataYMD.optional(),
})

const postBodySchema = z
  .object({
    schedaId: zUuid,
    giorno: zDataYMD,
    responsabile: zUuid,
  })
  .strict()

/** Quanti id di scheda in una sola `.in(...)`: l'URL di PostgREST ha un tetto, e 36 caratteri a id si sommano. */
const SCHEDE_PER_LETTURA = 100

type SchedaMinima = { id: string; genitore_nome: string | null; telefono1: string | null }

export const GET = withRoute('admin/crm/azioni:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/crm/azioni:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const oggi = dataCivile()
  const limite = fineGiornoCivile(q.data.finoA ?? oggi)
  if (limite === null) {
    return validationError([{ path: ['finoA'], message: 'Data inesistente nel calendario' }])
  }

  let query = supabase
    .from('crm_azioni')
    .select(
      'id, scuola_id, scheda_id, tipo, scadenza, responsabile, appuntamento_id, esito, fatta_da, fatta_il, cancellata_il, cancellata_da, creata_il',
    )
    .in('scuola_id', scuole)
    .is('fatta_il', null)
    .is('cancellata_il', null)
    .lte('scadenza', limite)
    .order('scadenza', { ascending: true })
  if (q.data.responsabile) query = query.eq('responsabile', q.data.responsabile)

  const { data: lette, error } = await query
  if (error) return rispostaErroreDb(error, 'admin/crm/azioni:GET')
  const azioni = (lette ?? []) as AzioneRow[]

  // Il nome e il telefono stanno sulla scheda: una lettura a parte, a pezzi, sempre ancorata alle sedi.
  const schede = new Map<string, SchedaMinima>()
  const idSchede = [...new Set(azioni.map((a) => a.scheda_id))]
  for (let i = 0; i < idSchede.length; i += SCHEDE_PER_LETTURA) {
    const { data, error: errScheda } = await supabase
      .from('crm_schede')
      .select('id, genitore_nome, telefono1')
      .in('id', idSchede.slice(i, i + SCHEDE_PER_LETTURA))
      .in('scuola_id', scuole)
    if (errScheda) return rispostaErroreDb(errScheda, 'admin/crm/azioni:GET')
    for (const s of data ?? []) {
      schede.set(s.id as string, {
        id: s.id as string,
        genitore_nome: (s.genitore_nome as string | null) ?? null,
        telefono1: (s.telefono1 as string | null) ?? null,
      })
    }
  }

  return NextResponse.json({
    data: azioni.map((a) => ({
      ...a,
      in_ritardo: dataCivile(new Date(a.scadenza)) < oggi,
      scheda: schede.get(a.scheda_id) ?? { id: a.scheda_id, genitore_nome: null, telefono1: null },
    })),
  })
})

export const POST = withRoute('admin/crm/azioni:POST', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const body = await parseBody(request, postBodySchema)
  if ('response' in body) return body.response

  const supabase = await createAdminClient()
  const gate = await assertSchedaInScope(supabase, auth.user, body.data.schedaId)
  if ('response' in gate) return gate.response

  const rifiuto = await assertPersonaInScope(supabase, body.data.responsabile, gate.scheda.scuola_id)
  if (rifiuto) return rifiuto

  const creata = await pianificaAzione(supabase, {
    schedaId: gate.scheda.id,
    scuolaId: gate.scheda.scuola_id,
    tipo: 'richiamare',
    giorno: body.data.giorno,
    responsabile: body.data.responsabile,
    autore: auth.user.id,
  })
  if (!creata) {
    // `pianificaAzione` non lancia e ha già scritto il motivo nel log: qui basta non fingere un 201.
    return NextResponse.json(
      { error: 'L’operazione non è riuscita. Riprova fra poco.', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
  return NextResponse.json({ data: { id: creata.id } }, { status: 201 })
})
