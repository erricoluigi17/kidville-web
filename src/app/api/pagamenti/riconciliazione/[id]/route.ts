import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const patchBodySchema = z.object({
  azione: z.enum(['conferma', 'ignora', 'riapri']),
  pagamento_id: zUuid.optional(),
})

interface Movimento {
  id: string
  scuola_id: string
  importo: number
  data_operazione: string
  causale: string | null
  stato: string
  suggerimenti?: { pagamento_id: string }[] | null
}

// PATCH /api/pagamenti/riconciliazione/[id] — conferma/ignora/riapri (staff).
// La CONFERMA crea l'incasso (metodo bonifico, data = data operazione): lo
// stato del pagamento lo ricalcola il trigger. Mai conferme automatiche.
export const PATCH = withRoute('pagamenti/riconciliazione/[id]:PATCH', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { azione } = b.data

    const supabase = await createAdminClient()
    const { data: movRaw } = await supabase
      .from('riconciliazione_movimenti')
      .select('id, scuola_id, importo, data_operazione, causale, stato, suggerimenti')
      .eq('id', id)
      .maybeSingle()
    if (!movRaw) return NextResponse.json({ error: 'Movimento non trovato' }, { status: 404 })
    const mov = movRaw as unknown as Movimento

    const sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    if (!sediAttive.includes(mov.scuola_id)) {
      return NextResponse.json({ error: 'Movimento fuori dalle sedi attive' }, { status: 403 })
    }

    if (azione === 'ignora') {
      if (mov.stato === 'confermato') {
        return NextResponse.json({ error: 'Movimento già confermato: stornare prima l’incasso' }, { status: 409 })
      }
      await supabase.from('riconciliazione_movimenti').update({ stato: 'ignorato' }).eq('id', id)
      return NextResponse.json({ success: true })
    }

    if (azione === 'riapri') {
      if (mov.stato === 'confermato') {
        return NextResponse.json({ error: 'Movimento già confermato: stornare prima l’incasso' }, { status: 409 })
      }
      await supabase.from('riconciliazione_movimenti').update({ stato: 'da_abbinare' }).eq('id', id)
      return NextResponse.json({ success: true })
    }

    // conferma
    if (mov.stato === 'confermato') {
      return NextResponse.json({ error: 'Movimento già confermato' }, { status: 409 })
    }
    const pagamentoId = b.data.pagamento_id ?? mov.suggerimenti?.[0]?.pagamento_id
    if (!pagamentoId) {
      return NextResponse.json({ error: 'Indica il pagamento da abbinare' }, { status: 400 })
    }
    const { data: pag } = await supabase
      .from('pagamenti')
      .select('id, scuola_id, stato')
      .eq('id', pagamentoId)
      .maybeSingle()
    if (!pag || !sediAttive.includes((pag as { scuola_id: string }).scuola_id)) {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }

    const { data: incasso, error: errInc } = await supabase
      .from('incassi')
      .insert({
        pagamento_id: pagamentoId,
        importo: mov.importo,
        data_incasso: mov.data_operazione,
        metodo: 'bonifico',
        note: `Riconciliazione: ${(mov.causale ?? '').slice(0, 160)}`.trim(),
        registrato_da: auth.user.id,
      })
      .select()
      .single()
    if (errInc) {
      return NextResponse.json({ error: 'Errore nella registrazione dell’incasso', details: errInc.message }, { status: 500 })
    }

    // CAS ottimistico: conferma solo se il movimento è ancora nello stato letto.
    // Due conferme concorrenti creerebbero due incassi per lo stesso bonifico
    // (#12): se la corsa è persa, storna l'incasso appena inserito.
    const { data: updated, error: errUpd } = await supabase
      .from('riconciliazione_movimenti')
      .update({
        stato: 'confermato',
        pagamento_id: pagamentoId,
        incasso_id: (incasso as { id: string }).id,
        confermato_da: auth.user.id,
        confermato_il: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('stato', mov.stato)
      .select('id')
    if (errUpd || !updated || updated.length === 0) {
      await supabase.from('incassi').delete().eq('id', (incasso as { id: string }).id)
      return NextResponse.json({ error: 'Movimento già riconciliato da un altro operatore' }, { status: 409 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_movimenti',
      entitaId: id,
      azione: 'update',
      scuolaId: mov.scuola_id,
      valoreDopo: { stato: 'confermato', pagamento_id: pagamentoId, importo: mov.importo },
    })

    return NextResponse.json({ success: true, data: { incasso_id: (incasso as { id: string }).id } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
