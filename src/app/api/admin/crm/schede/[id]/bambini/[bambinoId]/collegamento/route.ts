import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { collegaAMano, scollega } from '@/lib/crm/collegamento'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · il collegamento a mano fra un bambino della scheda e la sua domanda.
 *
 *  · `PUT    { domandaId, figlio }` → «questo figlio di questa domanda è questo bambino». Il bambino
 *    diventa iscritto (se non lo era già), la domanda gli resta attaccata e l'avviso «è arrivata una
 *    domanda» sulla scheda si spegne se riguardava quella.
 *  · `DELETE` → toglie il collegamento. L'esito del bambino NON cambia.
 *
 * Risposta: `200 { ok: true }`. Gli errori portano `codice` (vedi `CODICI_ERRORE`).
 *
 * ─── LA SEDE ────────────────────────────────────────────────────────────────
 * Non arriva dal client: è quella della SCHEDA, dopo che `assertSchedaInScope` ha verificato che sia di
 * una sede dell'utente (403 se no, 404 se non esiste). `collegaAMano` poi verifica che bambino e scheda
 * stiano in quella sede e che la DOMANDA sia della stessa sede: una domanda di un altro plesso è un 403,
 * non un collegamento. Ogni `update` porta la sede e «non ancora collegato» nella stessa istruzione.
 */

const bodySchema = z.object({
  domandaId: zUuid,
  // Posizione del figlio dentro la domanda (da 0). Il tetto è largo apposta: lo stringe `collegaAMano`
  // confrontandolo con i figli che la domanda ha davvero.
  figlio: z.number().int().min(0).max(50),
})

type Contesto = { params: Promise<{ id: string; bambinoId: string }> }

async function risolviId(context: Contesto) {
  const { id, bambinoId } = await context.params
  const scheda = parseData(zUuid, id)
  if ('response' in scheda) return scheda
  const bambino = parseData(zUuid, bambinoId)
  if ('response' in bambino) return bambino
  return { data: { schedaId: scheda.data, bambinoId: bambino.data } }
}

export const PUT = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/collegamento:PUT',
  async (request: NextRequest, context: Contesto) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const ids = await risolviId(context)
    if ('response' in ids) return ids.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const gate = await assertSchedaInScope(supabase, auth.user, ids.data.schedaId)
    if ('response' in gate) return gate.response

    const rifiuto = await collegaAMano(supabase, {
      schedaId: gate.scheda.id,
      scuolaId: gate.scheda.scuola_id,
      bambinoId: ids.data.bambinoId,
      domandaId: b.data.domandaId,
      figlio: b.data.figlio,
      autore: auth.user.id,
    })
    if (rifiuto) return rifiuto
    return NextResponse.json({ ok: true })
  },
)

export const DELETE = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/collegamento:DELETE',
  async (request: NextRequest, context: Contesto) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const ids = await risolviId(context)
    if ('response' in ids) return ids.response

    const supabase = await createAdminClient()
    const gate = await assertSchedaInScope(supabase, auth.user, ids.data.schedaId)
    if ('response' in gate) return gate.response

    const rifiuto = await scollega(supabase, {
      schedaId: gate.scheda.id,
      scuolaId: gate.scheda.scuola_id,
      bambinoId: ids.data.bambinoId,
      autore: auth.user.id,
    })
    if (rifiuto) return rifiuto
    return NextResponse.json({ ok: true })
  },
)
