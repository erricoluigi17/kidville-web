import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { saldoCredito } from '@/lib/pagamenti/credito'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Credito famiglia (slice S4 — Contabilità v2) ─────────────────────────────
// Visibile SOLO alla segreteria (requireStaff). Il saldo è il `saldo_dopo`
// cumulato del ledger `crediti_famiglia`; l'utilizzo su una voce passa dalla RPC
// atomica `utilizza_credito_famiglia` (service-role).

const getQuerySchema = z.object({ parent_id: zUuid })

const postBodySchema = z.object({
  parent_id: zUuid,
  pagamento_id: zUuid,
  importo: z.coerce.number().positive('L\'importo da utilizzare deve essere > 0'),
})

const round2 = (n: number) => Math.round(n * 100) / 100
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

// GET /api/pagamenti/credito?parent_id=  (staff) — saldo + movimenti.
export const GET = withRoute('pagamenti/credito:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const parentId = q.data.parent_id

    const supabase = await createAdminClient()
    const saldo = await saldoCredito(supabase, parentId)
    const { data: movimenti, error } = await supabase
      .from('crediti_famiglia')
      .select('id, causale, importo, saldo_dopo, transazione_id, incasso_id, creato_il')
      .eq('parent_id', parentId)
      .order('creato_il', { ascending: false })
      .limit(100)
    if (error && TABELLA_ASSENTE.has((error as { code?: string }).code ?? '')) {
      return NextResponse.json({ success: true, disponibile: false, data: { saldo: 0, movimenti: [] } })
    }
    if (error) {
      logErrore({ operazione: 'pagamenti/credito:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero del credito' }, { status: 500 })
    }
    return NextResponse.json({ success: true, disponibile: true, data: { saldo, movimenti: movimenti ?? [] } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/credito:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/credito  (staff) — utilizza il credito su una voce.
// Body: { parent_id, pagamento_id, importo }.
export const POST = withRoute('pagamenti/credito:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { parent_id, pagamento_id } = b.data
    const importo = round2(b.data.importo)

    const supabase = await createAdminClient()

    // Pre-check del saldo per un 409 pulito (la RPC lo ri-verifica in modo atomico).
    const saldo = await saldoCredito(supabase, parent_id)
    if (saldo + 0.005 < importo) {
      return NextResponse.json({ error: 'Credito insufficiente.', saldo }, { status: 409 })
    }

    const { data, error } = await supabase.rpc('utilizza_credito_famiglia', {
      p: { parent_id, pagamento_id, importo, registrato_da: user.id },
    })
    if (error) {
      const code = (error as { code?: string }).code ?? ''
      if (RPC_ASSENTE.has(code)) {
        return NextResponse.json({ error: 'Credito famiglia non disponibile su questo ambiente' }, { status: 503 })
      }
      if (code === 'P0001') {
        // Raise applicativo (es. credito insufficiente per una corsa concorrente).
        return NextResponse.json({ error: 'Impossibile utilizzare il credito: saldo insufficiente o dato non valido.' }, { status: 409 })
      }
      logErrore({ operazione: 'pagamenti/credito:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'utilizzo del credito', details: error.message }, { status: 500 })
    }

    const esito = (data ?? {}) as { incasso_id?: string; importo?: number; saldo?: number }
    // Evento critico → SUCCESSO loggato (importo/uuid, MAI PII).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/credito:POST',
      esito: 'credito_utilizzato',
      pagamento_id,
      importo,
    })

    // Revoca automatica della sospensione se lo scaduto famiglia è azzerato.
    try {
      const { data: pag } = await supabase.from('pagamenti').select('alunno_id').eq('id', pagamento_id).maybeSingle()
      const alunnoId = (pag as { alunno_id?: string | null } | null)?.alunno_id
      if (alunnoId) await verificaRevocaSospensioneMorosita(supabase, [alunnoId])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/credito:POST', esito: 'revoca_non_verificata' }, e)
    }

    return NextResponse.json({ success: true, data: esito })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/credito:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
