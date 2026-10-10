import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'

const OP = 'pagamenti/ticket/storico:GET'
/** Il ledger assente (DB E2E della CI non migrato): l'unico caso che degrada a «nessun movimento». */
const LEDGER_ASSENTE = new Set(['42P01', 'PGRST205', '42703'])

const getQuerySchema = z.object({ alunno_id: zUuid })

// GET /api/pagamenti/ticket/storico?userId=&alunno_id=
//   staff (incl. segreteria): storico movimenti ticket (ledger) + saldo corrente.
//   Le ricariche embeddano il pagamento (descrizione/importo/stato/metodo).
export const GET = withRoute('pagamenti/ticket/storico:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const alunnoId = q.data.alunno_id

    const supabase = await createAdminClient()
    const scopeErr = await assertAlunnoInScope(supabase, user, alunnoId)
    if (scopeErr) return scopeErr

    const [movRes, saldoRes] = await Promise.all([
      supabase
        .from('mensa_ticket_movimenti')
        .select('id, tipo, delta, saldo_dopo, data, origine, note, creato_il, pagamento_id, pagamenti ( descrizione, importo, stato, incassi ( metodo ) )')
        .eq('alunno_id', alunnoId)
        .order('creato_il', { ascending: false })
        .limit(300),
      supabase.from('ticket_mensa').select('saldo_ticket, ultimo_carico').eq('alunno_id', alunnoId).maybeSingle(),
    ])

    // Il saldo non letto NON è un saldo zero (fase 5 robustezza, sesto pezzo): la schermata
    // mostrava «0 ticket» a una famiglia che li aveva pagati.
    if (saldoRes.error) return rispostaGuastoDb(OP, 'db:ticket_mensa', saldoRes.error)
    // Degrado SOLO se la tabella ledger non esiste ancora sul DB (CI drift); ogni altro errore
    // era uno storico vuoto, senza una riga di log.
    if (movRes.error && !LEDGER_ASSENTE.has(movRes.error.code ?? '')) {
      return rispostaGuastoDb(OP, 'db:mensa_ticket_movimenti', movRes.error)
    }
    const movimenti = movRes.error ? [] : (movRes.data ?? [])

    return NextResponse.json({
      success: true,
      data: {
        saldo_ticket: Number(saldoRes.data?.saldo_ticket ?? 0),
        ultimo_carico: saldoRes.data?.ultimo_carico ?? null,
        movimenti,
      },
    })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
