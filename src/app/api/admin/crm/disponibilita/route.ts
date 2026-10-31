import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { assertPersonaInScope, personeDellaSede, requireCrm } from '@/lib/crm/accesso'
import { assertSedeInScope } from '@/lib/crm/agenda'
import {
  CODICI_RPC_CRM_ASSENTE,
  codiceErroreDb,
  rispostaCrmNonInstallato,
  rispostaCrmNonRiuscita,
  rispostaErroreDb,
} from '@/lib/crm/errori'
import { fasceDellaSettimana, leggiSettimaneEFasce, lunediDi, settimanaModificabile } from '@/lib/crm/settimane'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zOraHHMM, zUuid } from '@/lib/validation/common'
import { parseBody, parseQuery, validationError } from '@/lib/validation/http'

/**
 * CRM della segreteria · le disponibilità, SETTIMANA PER SETTIMANA, di una persona o della sede.
 *
 *  · `GET /api/admin/crm/disponibilita?scuolaId&settimana=YYYY-MM-DD` — le fasce di quella settimana (qualunque
 *    giorno: si normalizza al lunedì). Una riga per la sede e una per ogni persona della sede, anche vuote, ognuna
 *    con la sua `origine` (`registrata`, `ereditata` da `daSettimana`, `nessuna`): «una settimana mai toccata è
 *    uguale all'ultima registrata prima di lei» (`src/lib/crm/settimane.ts`). Dice anche se la settimana si può
 *    ancora modificare, le persone della sede e `io`, cioè chi sta chiedendo;
 *  · `PUT /api/admin/crm/disponibilita` — salva TUTTE le fasce di un proprietario (`utenteId` nullo = la sede)
 *    per una settimana. La funzione SQL `crm_salva_settimana` le sostituisce in una scrittura sola: così la copia
 *    di ciò che si ereditava e la modifica non restano a metà. Modificare una settimana vale per quella e per
 *    tutte le successive finché qualcuno non la cambia di nuovo. Le settimane passate non si modificano.
 *
 * Ogni persona della sede cambia le fasce della sede e quelle delle colleghe (spec §6.1): niente `SOLO_LA_PROPRIA`.
 * Ma la funzione SQL NON verifica che la persona sia della sede (il vincolo protegge le fasce dalla testata, non
 * la testata dalla persona): lo fa questa route, con `assertPersonaInScope`, PRIMA di chiamarla.
 */

const OP_GET = 'admin/crm/disponibilita:GET'
const OP_PUT = 'admin/crm/disponibilita:PUT'

const getQuerySchema = z.object({ scuolaId: zUuid, settimana: zDataYMD })

export const GET = withRoute('admin/crm/disponibilita:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const fuoriSede = await assertSedeInScope(supabase, auth.user, q.data.scuolaId, OP_GET)
  if (fuoriSede) return fuoriSede
  const scuolaId = q.data.scuolaId
  const lunedi = lunediDi(q.data.settimana)

  // Le persone della sede e le testate/fasce si leggono insieme. Entrambe LANCIANO l'errore del database:
  // un `[]` direbbe alla segretaria «nessuno è disponibile» quando in realtà non lo sappiamo.
  let persone
  let letti
  try {
    ;[persone, letti] = await Promise.all([
      personeDellaSede(supabase, scuolaId),
      leggiSettimaneEFasce(supabase, scuolaId, lunedi, lunedi),
    ])
  } catch (err) {
    return rispostaErroreDb(err as { code?: string; message?: string }, OP_GET)
  }

  // Una riga per la sede e una per ogni persona della sede: chi ha una vecchia testata ma non è più della sede
  // (archiviata, o ha cambiato plesso) non esce.
  const proprietari = fasceDellaSettimana(letti.settimane, letti.fasce, lunedi, [null, ...persone.map((p) => p.id)])

  // `io` dice a chi guarda CHI È (id e ruolo letti dalla sessione, non dal client).
  return NextResponse.json({
    data: {
      settimana: lunedi,
      modificabile: settimanaModificabile(lunedi, dataCivile(new Date())),
      proprietari,
      persone,
    },
    io: { id: auth.user.id, ruolo: auth.user.role },
  })
})

const fasciaSchema = z.object({
  giornoSettimana: z.number().int().min(1).max(7),
  oraInizio: zOraHHMM,
  oraFine: zOraHHMM,
  durataSlotMin: z.number().int().min(15).max(240),
})

const putSchema = z
  .object({
    scuolaId: zUuid,
    settimana: zDataYMD,
    // nullo = la sede; mancante non è ammesso: «per chi è» si dice sempre
    utenteId: zUuid.nullable(),
    fasce: z.array(fasciaSchema).max(50),
  })
  .superRefine((b, ctx) => {
    b.fasce.forEach((f, i) => {
      if (f.oraFine <= f.oraInizio) {
        ctx.addIssue({ code: 'custom', path: ['fasce', i, 'oraFine'], message: 'L’ora di fine deve seguire quella di inizio' })
      }
    })
  })

export const PUT = withRoute('admin/crm/disponibilita:PUT', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, putSchema)
  if ('response' in b) return b.response
  const { scuolaId, settimana, utenteId, fasce } = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertSedeInScope(supabase, auth.user, scuolaId, OP_PUT)
  if (fuoriSede) return fuoriSede

  if (utenteId !== null) {
    const nonDellaSede = await assertPersonaInScope(supabase, utenteId, scuolaId)
    if (nonDellaSede) return nonDellaSede
  }

  const { data, error } = await supabase.rpc('crm_salva_settimana', {
    p_scuola_id: scuolaId,
    p_utente_id: utenteId,
    p_settimana: settimana,
    // Le chiavi sono quelle che la funzione legge con `jsonb_to_recordset`.
    p_fasce: fasce.map((f) => ({
      giorno_settimana: f.giornoSettimana,
      ora_inizio: f.oraInizio,
      ora_fine: f.oraFine,
      durata_slot_min: f.durataSlotMin,
    })),
    p_eseguito_da: auth.user.id,
  })
  if (error) {
    if (codiceErroreDb(error) === '22023') {
      // La validazione di sopra dovrebbe averlo fermato: se la funzione rifiuta gli argomenti, qualcosa non torna
      // fra le due. Non è un guasto del server (500) ma nemmeno una cosa da far passare in silenzio: avviso nel log
      // e 400, come fa la route della quota.
      logEvento('crm', 'warn', { operazione: OP_PUT, esito: 'settimana-argomenti-non-validi', scuola_id: scuolaId }, error)
      return validationError([{ path: ['fasce'], message: 'Dati non validi' }])
    }
    // Dopo una `rpc` valgono SOLO i quattro codici di «funzione o tabella assente»: su una funzione installata
    // un `42703` è un errore vero nel suo corpo, e non deve travestirsi da «CRM non installato».
    if (CODICI_RPC_CRM_ASSENTE.has(codiceErroreDb(error))) {
      logEvento('crm', 'warn', { operazione: OP_PUT, esito: 'schema-crm-assente', scuola_id: scuolaId }, error)
      return rispostaCrmNonInstallato()
    }
    return rispostaErroreDb(error, OP_PUT)
  }

  const esito = (data ?? {}) as Record<string, unknown>
  switch (esito.esito) {
    case 'ok': {
      const settimanaId = typeof esito.settimana_id === 'string' ? esito.settimana_id : null
      logEvento('crm', 'info', {
        operazione: OP_PUT,
        esito: 'settimana-salvata',
        scuola_id: scuolaId,
        n: fasce.length,
        ...(settimanaId ? { entita_id: settimanaId } : {}),
      })
      return NextResponse.json({ data: { settimanaId, settimana, utenteId } })
    }
    case 'settimana_passata':
      logEvento('crm', 'info', { operazione: OP_PUT, esito: 'settimana-rifiutata:settimana_passata', scuola_id: scuolaId })
      return NextResponse.json(
        { error: 'La settimana è già passata: non si può più modificare.', codice: 'SETTIMANA_PASSATA' },
        { status: 409 },
      )
    case 'fasce_sovrapposte':
      logEvento('crm', 'info', { operazione: OP_PUT, esito: 'settimana-rifiutata:fasce_sovrapposte', scuola_id: scuolaId })
      return NextResponse.json(
        { error: 'Due fasce dello stesso giorno si sovrappongono.', codice: 'FASCE_SOVRAPPOSTE' },
        { status: 422 },
      )
    case 'settimana_non_valida':
      // La validazione di sopra accetta ogni data vera; la funzione vuole un lunedì.
      logEvento('crm', 'info', { operazione: OP_PUT, esito: 'settimana-rifiutata:settimana_non_valida', scuola_id: scuolaId })
      return validationError([{ path: ['settimana'], message: 'La settimana deve cominciare di lunedì' }])
    default:
      // Una risposta che la route non sa leggere è un guasto di configurazione, non una richiesta sbagliata.
      logEvento('crm', 'error', { operazione: OP_PUT, esito: 'settimana-risposta-illeggibile', scuola_id: scuolaId })
      return rispostaCrmNonRiuscita()
  }
})
