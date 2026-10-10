import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { eseguiStornoIncasso } from '../storno/route'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { guastoSecondario, rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'

const patchBodySchema = z
  .object({
    // importo può arrivare come numero o stringa numerica; ≠ 0 come da check storico
    importo: z.coerce.number().optional(),
    data_incasso: z.string().nullish(),
    metodo: z.string().nullish(),
    note: z.string().nullish(),
  })
  .refine(
    (b) =>
      b.importo !== undefined ||
      b.data_incasso !== undefined ||
      b.metodo !== undefined ||
      b.note !== undefined,
    'Nessun campo da aggiornare'
  )
  .refine((b) => b.importo === undefined || b.importo !== 0, 'importo deve essere ≠ 0')

// PATCH /api/pagamenti/incassi/[id]  (staff) — correzione di un incasso registrato
// Body: { userId, importo?, data_incasso?, metodo?, note? }
// Lo stato del pagamento è ricalcolato automaticamente dal trigger su `incassi`.
export const PATCH = withRoute('pagamenti/incassi/[id]:PATCH', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    // Un guasto non è «non trovato» (fase 5 robustezza, sesto pezzo).
    const { data: old, error: errOld } = await supabase.from('incassi').select('*').eq('id', id).maybeSingle()
    if (errOld) return rispostaGuastoDb('pagamenti/incassi/[id]:PATCH', 'db:incassi', errOld)
    if (!old) return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })

    // Isolamento per sede: l'incasso non ha una sede propria, ma il PAGAMENTO a
    // cui si riferisce si'. Senza questo si modificava (e si eliminava) un
    // incasso registrato in un'altra sede conoscendone l'uuid.
    const fuoriScopeInc = await assertPagamentoInScope(supabase, auth.user, old.pagamento_id as string)
    if (fuoriScopeInc) return fuoriScopeInc

    const allowed = ['importo', 'data_incasso', 'metodo', 'note'] as const
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]

    const { data: incasso, error } = await supabase
      .from('incassi').update(updates).eq('id', id).select().single()
    if (error) return rispostaGuastoDb('pagamenti/incassi/[id]:PATCH', 'db:incassi:update', error, 'scrittura')

    // La traccia della modifica: l'incasso è GIÀ aggiornato, quindi un guasto qui non
    // cambia la risposta — ma prima lo inghiottiva `.then(() => {}, () => {})`, e una
    // modifica di un importo incassato restava senza il «prima» e il «dopo».
    const { error: errAudit } = await supabase.from('registro_modifiche').insert({
      azione: 'modifica_incasso',
      tabella_interessata: 'incassi',
      record_id: id,
      vecchio_valore: old,
      nuovo_valore: incasso,
      utente_id: user.id,
    })
    if (errAudit) guastoSecondario('pagamenti/incassi/[id]:PATCH', 'audit-non-scritto', errAudit)

    // stato pagamento ricalcolato dal trigger
    const { data: pagamento, error: errPag } = await supabase
      .from('pagamenti').select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', incasso.pagamento_id).maybeSingle()
    if (errPag) guastoSecondario('pagamenti/incassi/[id]:PATCH', 'pagamento-non-riletto', errPag)

    return NextResponse.json({ success: true, data: { incasso, pagamento } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/incassi/[id]?motivo=yyy  (staff) — storno TRACCIATO
// Wrapper della stessa logica dello storno: niente più cancellazione fisica.
// Il motivo è obbligatorio (query ?motivo= o body), min 3 caratteri.
export const DELETE = withRoute('pagamenti/incassi/[id]:DELETE', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    let motivo: string | undefined
    try {
      const url = new URL(request.url)
      motivo = url.searchParams.get('motivo')?.trim() || undefined
    } catch {
      motivo = undefined
    }
    if (!motivo || motivo.length < 3) {
      try {
        const parsed = await request.json()
        const m = (parsed as { motivo?: string } | null)?.motivo?.trim()
        if (m) motivo = m
      } catch {
        // nessun body JSON: il motivo doveva arrivare in query
      }
    }
    if (!motivo || motivo.length < 3) {
      return NextResponse.json({ error: 'Motivo dello storno obbligatorio (min 3 caratteri)' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const esito = await eseguiStornoIncasso(supabase, { incassoId: id, motivo, userId: user.id })
    return NextResponse.json(esito.body, { status: esito.status })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
