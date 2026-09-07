import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireKitchenRead } from '@/lib/auth/require-staff'
import { assertAlunnoInScopeCucina } from '@/lib/mensa/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({ alunno_id: zUuid })

/** Tetto dei movimenti restituiti: come lo storico contabile, per lo stesso ledger. */
const LIMITE_MOVIMENTI = 300

interface MovimentoRow {
  id: string
  tipo: string
  delta: number | null
  saldo_dopo: number | null
  data: string | null
  origine: string | null
}

/**
 * GET /api/mensa/ticket-residui/storico?userId=&alunno_id=
 *
 * Quando quel bambino ha COMPRATO i ticket e quando li ha USATI, una riga per
 * movimento. È la vista della cucina sul ledger `mensa_ticket_movimenti`.
 *
 * ⚠️ NON è un doppione di `GET /api/pagamenti/ticket/storico`, che resta la vista
 * CONTABILE: quella passa da `requireStaff` (cuoca e insegnanti esclusi) e porta
 * importi, metodo di pagamento e stato della ricevuta. Qui il gate è
 * `requireKitchenRead` — entrano anche la cuoca e l'insegnante della classe — e
 * proprio per questo escono SOLO le date e le quantità: alla cucina gli euro non
 * servono, e ciò che non serve non si mostra.
 *
 * Le `note` del movimento (testo libero, dove qualcuno può aver scritto qualunque
 * cosa) non escono per lo stesso motivo.
 */
export const GET = withRoute('mensa/ticket-residui/storico:GET', async (request: NextRequest) => {
  try {
    const auth = await requireKitchenRead(request)
    if (auth.response) return auth.response
    const { user } = auth

    const qp = parseQuery(request, getQuerySchema)
    if ('response' in qp) return qp.response
    const alunnoId = qp.data.alunno_id

    const supabase = await createAdminClient()

    // Sede + (per l'insegnante) classe. La cuoca non ha sezioni assegnate: vedi
    // la testata di `assertAlunnoInScopeCucina` per il perché non è quella di auth.
    const scopeErr = await assertAlunnoInScopeCucina(request, supabase, user, alunnoId)
    if (scopeErr) return scopeErr

    const [movRes, saldoRes] = await Promise.all([
      supabase
        .from('mensa_ticket_movimenti')
        .select('id, tipo, delta, saldo_dopo, data, origine')
        .eq('alunno_id', alunnoId)
        .order('data', { ascending: false })
        .order('creato_il', { ascending: false })
        .limit(LIMITE_MOVIMENTI),
      supabase.from('ticket_mensa').select('saldo_ticket, ultimo_carico').eq('alunno_id', alunnoId).maybeSingle(),
    ])

    // PostgREST non lancia: il ledger può mancare sul DB E2E della CI. Si degrada
    // a elenco vuoto, ma DICHIARANDOLO: «nessun movimento» e «non ho potuto
    // leggerli» sono due frasi diverse, e la seconda non deve travestirsi da prima.
    const storicoNonDisponibile = Boolean(movRes.error)
    if (movRes.error) {
      logEvento('db', 'error', {
        operazione: 'mensa/ticket-residui/storico:GET',
        esito: 'ledger-movimenti-non-letto',
      }, movRes.error)
    }

    const movimenti = ((movRes.data ?? []) as MovimentoRow[]).map((m) => ({
      id: m.id,
      tipo: m.tipo,
      delta: Number(m.delta ?? 0),
      saldo_dopo: m.saldo_dopo === null || m.saldo_dopo === undefined ? null : Number(m.saldo_dopo),
      data: m.data,
      origine: m.origine,
    }))

    return NextResponse.json({
      success: true,
      data: {
        saldo_ticket: Number(saldoRes.data?.saldo_ticket ?? 0),
        ultimo_carico: saldoRes.data?.ultimo_carico ?? null,
        movimenti,
        storico_non_disponibile: storicoNonDisponibile,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'mensa/ticket-residui/storico:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error', codice: 'MENSA_TICKET_NON_LETTI' }, { status: 500 })
  }
})
