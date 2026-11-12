import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope } from '@/lib/anno/impostazioni'
import { erroreAnno } from '@/lib/anno/errori'
import { impostaDocentePassaggio } from '@/lib/anno/passaggio'
import { passaggioDellAnno, rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * AGGIUNGE O TOGLIE UN DOCENTE da una sezione nuova, nell'anteprima del passaggio (PR 4.8, compito 4.8.8). `annoSedeId` = l'anno
 * NUOVO. `origine`: `aggiunta` mette il docente sulla sezione (e ripristina una `tolta`); `tolta` lo toglie (a una `copiata` la
 * marca, non la cancella). Il passaggio dev'essere ancora in anteprima (`PASSAGGIO_NON_MODIFICABILE`, 409).
 * Il passaggio lo trova il SERVER dall'anno dell'URL; `p_da` è l'utente del token. Nei log: uuid, codici, numeri.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const putSchema = z
  .object({
    utente_id: zUuid,
    section_id: zUuid,
    /** Elenco chiuso: `copiata` la scrive solo il calcolo dell'anteprima. */
    origine: z.enum(['aggiunta', 'tolta']),
  })
  .strict()

export const PUT = withRoute('admin/anni/[annoSedeId]/passaggio/docenti:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio/docenti:PUT'
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
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  /** Il personale della sede dell'anno, non un genitore. `errore` = non lo so (la lettura è caduta): la route risponde 500, non indovina. */
  const docenteAmmesso = async (utenteId: string): Promise<'si' | 'no' | 'errore'> => {
    const [anno, utente] = await Promise.all([
      supabase.from('anni_sede').select('scuola_id').eq('id', annoSedeId).maybeSingle(),
      supabase.from('utenti').select('id, ruolo, scuola_id, archiviato_il').eq('id', utenteId).maybeSingle(),
    ])
    if (anno.error || utente.error) {
      logErrore({ operazione: 'admin/anni/[annoSedeId]/passaggio/docenti:PUT' }, anno.error ?? utente.error)
      return 'errore'
    }
    if (!anno.data || !utente.data) return 'no'
    const u = utente.data as { ruolo: string | null; scuola_id: string | null; archiviato_il?: string | null }
    // (giro 2, R7) Né un genitore né un account archiviato (docente revocato).
    if (u.ruolo === 'genitore' || u.archiviato_il) return 'no'
    return u.scuola_id && u.scuola_id === (anno.data as { scuola_id: string }).scuola_id ? 'si' : 'no'
  }

  const passaggio = await passaggioDellAnno(supabase, annoSedeId, ctx)
  if ('response' in passaggio) return passaggio.response

  // (giro 1, B5) Aggiungere = mettere una persona su una classe: dev'essere del personale di QUESTA sede e non un genitore. Togliere
  // no: chi è già in elenco si può sempre togliere.
  if (corpo.origine === 'aggiunta') {
    const ammesso = await docenteAmmesso(corpo.utente_id)
    if (ammesso === 'errore') {
      // Una lettura caduta non è «docente valido»: 500 `SCRITTURA_FALLITA` (il codice che la pagina sa già tradurre), il SQLSTATE l'ha già scritto `logErrore`.
      return rispostaPassaggioNonRiuscito({ ok: false, codice: 'SCRITTURA_FALLITA' }, ctx)
    }
    if (ammesso === 'no') {
      logEvento('anno-scolastico', 'warn', { tipo: 'passaggio-docente-non-valido', operazione, entita_id: passaggio.passaggioId, utente: auth.user.id, error_code: 'DOCENTE_NON_VALIDO' })
      return erroreAnno({ message: 'DOCENTE_NON_VALIDO' }, operazione)!
    }
  }

  const esito = await impostaDocentePassaggio(supabase, {
    passaggioId: passaggio.passaggioId,
    utenteId: corpo.utente_id,
    sezioneId: corpo.section_id,
    origine: corpo.origine,
    da: auth.user.id,
  })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  // (giro 2, R5) «Togli» vale per l'elenco del passaggio: chi è GIÀ assegnato alla classe nuova dalla scheda della classe resta assegnato.
  // La pagina lo dice. Una lettura caduta non cambia l'esito (`resta_assegnato` assente), ma si registra.
  let restaAssegnato: boolean | undefined
  if (corpo.origine === 'tolta') {
    const gia = await supabase.from('utenti_sezioni').select('utente_id').eq('utente_id', corpo.utente_id).eq('section_id', corpo.section_id).limit(1)
    if (gia.error) logErrore({ operazione }, gia.error)
    else restaAssegnato = (gia.data ?? []).length > 0
  }

  logEvento('anno-scolastico', 'info', {
    tipo: 'passaggio-docente-impostato',
    operazione,
    esito: corpo.origine,
    n: 1,
    entita_id: passaggio.passaggioId,
    utente: auth.user.id,
  })
  return NextResponse.json({
    success: true,
    data: {
      utente_id: esito.utente_id ?? corpo.utente_id,
      sezione_a_id: esito.sezione_a_id ?? corpo.section_id,
      origine: esito.origine ?? corpo.origine,
      ...(restaAssegnato === undefined ? {} : { resta_assegnato: restaAssegnato }),
    },
  })
})
