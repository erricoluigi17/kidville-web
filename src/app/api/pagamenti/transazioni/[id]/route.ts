import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

// GET /api/pagamenti/transazioni/[id]  (staff) — dettaglio: transazione +
// incassi collegati + eventuali righe di credito famiglia.
export const GET = withRoute('pagamenti/transazioni/[id]:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()

    const { data: tx, error } = await supabase
      .from('pagamenti_transazioni')
      .select('id, scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, annullata_il, annullo_motivo, creato_il, registrato_da')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      if (TABELLA_ASSENTE.has((error as { code?: string }).code ?? '')) {
        return NextResponse.json({ success: true, data: null, disponibile: false })
      }
      logErrore({ operazione: 'pagamenti/transazioni/[id]:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero della transazione' }, { status: 500 })
    }
    if (!tx) return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })

    // Scope di sede.
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(String((tx as { scuola_id: string }).scuola_id))) {
      return NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 })
    }

    const { data: incassi } = await supabase
      .from('incassi')
      .select('id, pagamento_id, importo, data_incasso, metodo, storno_di, stornato_il, creato_il, pagamenti:pagamento_id ( descrizione, alunni:alunno_id ( nome, cognome ) )')
      .eq('transazione_id', id)
      .order('creato_il', { ascending: true })

    const { data: crediti } = await supabase
      .from('crediti_famiglia')
      .select('id, causale, importo, saldo_dopo, creato_il')
      .eq('transazione_id', id)
      .order('creato_il', { ascending: true })

    return NextResponse.json({ success: true, disponibile: true, data: { ...tx, incassi: incassi ?? [], crediti: crediti ?? [] } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
