import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// POST /api/chat/threads/[id]/riapri (C5 §2)
//
// Riapre la conversazione sospesa. Riapertura = UPDATE dei SOLI campi riaperta_*
// sulla riga ATTIVA (riaperta_il IS NULL): mai un secondo INSERT, mai un DELETE.
// Lo storico append-only resta intero (contestazioni: sospendi→riapri→sospendi).
//
// AUTORIZZAZIONE: solo chi ha sospeso (sospesa_da === chiamante, tipo
// 'sospendente') oppure lo staff di Direzione (admin/coordinator, tipo
// 'direzione'). Chiunque altro → 403.
// =============================================================================

interface RouteParams {
  params: Promise<{ id: string }>
}

const OP = 'chat/threads/[id]/riapri:POST'

export const POST = withRoute('chat/threads/[id]/riapri:POST', async (request: Request, { params }: RouteParams) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response
  const uid = auth.user.id
  const role = auth.user.role

  const p = parseData(zUuid, (await params).id)
  if ('response' in p) return p.response
  const threadId = p.data

  try {
    const supabase = await createAdminClient()

    // Riga della sospensione ATTIVA (indice parziale riaperta_il IS NULL).
    const { data: attiva, error } = await supabase
      .from('conversazioni_sospensioni')
      .select('id, sospesa_da')
      .eq('thread_id', threadId)
      .is('riaperta_il', null)
      .maybeSingle()
    if (error) {
      // DB E2E CI non migrato: degrada pulito.
      if (schemaAssente(error)) return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!attiva) {
      return NextResponse.json({ error: 'Nessuna sospensione attiva per questa conversazione' }, { status: 404 })
    }

    const isSospendente = (attiva.sospesa_da as string) === uid
    const isDirezione = role === 'admin' || role === 'coordinator'
    if (!isSospendente && !isDirezione) {
      logEvento('chat', 'info', { operazione: OP, esito: 'non-autorizzato', threadId })
      return NextResponse.json({ error: 'Non sei autorizzato a riaprire questa conversazione' }, { status: 403 })
    }
    // Chi ha sospeso prevale come tipo; altrimenti è la Direzione a mediare.
    const riapertaTipo = isSospendente ? 'sospendente' : 'direzione'

    // UPDATE dei soli campi riaperta_*, SOLO se ancora attiva (idempotenza:
    // due riaperture concorrenti non si sovrascrivono a vicenda).
    const { error: updErr } = await supabase
      .from('conversazioni_sospensioni')
      .update({
        riaperta_il: new Date().toISOString(),
        riaperta_da: uid,
        riaperta_tipo: riapertaTipo,
      })
      .eq('id', attiva.id)
      .is('riaperta_il', null)
    if (updErr) {
      if (schemaAssente(updErr)) return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, updErr)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }

    logEvento('chat', 'info', { operazione: OP, esito: 'conversazione-riaperta', threadId })
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
