import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({ alunno_id: zUuid })

// GET /api/pagamenti/ticket/storico?userId=&alunno_id=
//   staff (incl. segreteria): storico movimenti ticket (ledger) + saldo corrente.
//   Le ricariche embeddano il pagamento (descrizione/importo/stato/metodo).
export async function GET(request: Request) {
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

    // Degrado graceful se la tabella ledger non esiste ancora sul DB (es. CI drift)
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
    console.error('Errore API GET ticket/storico:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
