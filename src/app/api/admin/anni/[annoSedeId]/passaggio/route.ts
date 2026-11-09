import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { anteprimaPassaggio, AVVISI_PASSAGGIO, ESITI_PASSAGGIO, leggiPassaggio } from '@/lib/anno/passaggio'
import { rispostaPassaggioNonRiuscito } from '@/lib/anno/passaggio-risposte'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zLimite, zUuid } from '@/lib/validation/common'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * IL PASSAGGIO D'ANNO (PR 4.8, compito 4.8.8). `annoSedeId` = `anni_sede.id` dell'anno NUOVO, quello con le iscrizioni aperte.
 *
 *  · GET  — il passaggio non annullato verso quell'anno: stato, conteggi, `apribile_dal`, UNA PAGINA di righe (filtri `?esito=`,
 *    `?avviso=`, `?pagina=`, `?tetto=`) col totale del filtro, e i docenti. SOLO uuid e stati: i nomi dei bambini li compone la
 *    pagina da `alunni` e dall'elenco delle sezioni, come fa «Conferme». Nessun passaggio → 200 con `passaggio: null`.
 *  · POST — `{ azione: 'anteprima' }`: calcola (o ricalcola) l'anteprima. L'anno di partenza è l'anno ATTIVO della sede, letto dal
 *    server (`anno_attivo`): il client non lo sceglie, e non manda nemmeno un giorno «oggi».
 *
 * Gate e perimetro: staff, e sia l'anno nuovo sia quello di partenza dev'essere di una sede dell'utente (`assertAnnoSedeInScope`).
 * Le regole stanno nel database; qui si giudicano chi chiede e per quale sede, si valida il corpo e si traduce il rifiuto.
 * Nei log: uuid, codici, numeri. Mai un nome.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const

const getQuerySchema = z.object({
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  tetto: zLimite({ predefinito: 100, max: 200 }),
  /** Elenco chiuso: gli esiti del passaggio. */
  esito: z.enum(ESITI_PASSAGGIO).optional(),
  /** Elenco chiuso: i segnali che la segreteria deve chiudere. */
  avviso: z.enum(AVVISI_PASSAGGIO).optional(),
})

export const GET = withRoute('admin/anni/[annoSedeId]/passaggio:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { pagina, tetto, esito, avviso } = q.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true }

  const letto = await leggiPassaggio(supabase, annoSedeId, { esito, avviso, pagina, tetto })
  if (!letto.ok || 'saltata' in letto) return rispostaPassaggioNonRiuscito(letto, ctx)

  logEvento('anno-scolastico', 'info', {
    tipo: 'passaggio-letto',
    operazione,
    anno_sede_id: annoSedeId,
    utente: auth.user.id,
    n: letto.righe.length,
  })
  return NextResponse.json({
    success: true,
    data: { passaggio: letto.passaggio, righe: letto.righe, totale: letto.totale, pagina, tetto, docenti: letto.docenti },
  })
})

/** Il corpo: una sola azione per ora. `strict`: un anno di partenza o un giorno «oggi» dal client sono un 400. */
const postSchema = z.object({ azione: z.literal('anteprima') }).strict()

export const POST = withRoute('admin/anni/[annoSedeId]/passaggio:POST', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/passaggio:POST'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, postSchema)
  if ('response' in b) return b.response

  const supabase = await createAdminClient()
  const letta: { scuolaId?: string } = {}
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione, letta)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO }

  // L'anno di partenza è l'attivo della sede, deciso dal server; senza un anno attivo diverso dal nuovo non c'è passaggio da fare.
  const attivo = await supabase.rpc('anno_attivo', { p_scuola: letta.scuolaId })
  if (attivo.error) return rispostaErroreImpostazioni(attivo.error, { ...ctx, lettura: true })
  const partenzaId = typeof attivo.data === 'string' ? attivo.data : null
  if (!partenzaId || partenzaId === annoSedeId) {
    return rispostaErroreImpostazioni({ message: 'PASSAGGIO_NON_PRONTO' }, ctx)
  }
  // Anche l'anno di partenza dev'essere dentro il perimetro.
  const fuoriSedePartenza = await assertAnnoSedeInScope(supabase, auth.user, partenzaId, operazione)
  if (fuoriSedePartenza) return fuoriSedePartenza

  const esito = await anteprimaPassaggio(supabase, { daAnnoSedeId: partenzaId, aAnnoSedeId: annoSedeId, da: auth.user.id })
  if (!esito.ok || 'saltata' in esito) return rispostaPassaggioNonRiuscito(esito, ctx)

  // Il successo l'ha già scritto la porta (`passaggio-anteprima`): uuid, esito e numeri.
  return NextResponse.json({
    success: true,
    data: {
      passaggio_id: esito.passaggio_id,
      creato: esito.creato,
      righe: esito.righe,
      avvisi: esito.avvisi ?? {},
      docenti: esito.docenti ?? {},
      apribile_dal: esito.apribile_dal ?? null,
    },
  })
})
