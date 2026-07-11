import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// scuola_id è advisory: lo scoping reale viene da resolveScuoleAttive (cookie/plessi).
const getQuerySchema = z.object({ scuola_id: zUuid.optional() })

// GET /api/pagamenti/ticket/morosi?userId=&scuola_id=
//   staff (incl. segreteria): alunni con saldo ticket NEGATIVO nelle sedi attive.
//   ticket_mensa non ha scuola_id → join !inner su alunni per lo scoping (no leak).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, user)
    if (!scuole.length) return NextResponse.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('ticket_mensa')
      .select('saldo_ticket, ultimo_carico, alunni!inner ( id, nome, cognome, classe_sezione, scuola_id )')
      .lt('saldo_ticket', 0)
      .in('alunni.scuola_id', scuole)
      .order('saldo_ticket', { ascending: true })
    if (error) return NextResponse.json({ error: 'Errore caricamento morosi ticket', details: error.message }, { status: 500 })

    const rows = (data ?? []).map((r) => {
      const raw = (r as { alunni?: unknown }).alunni
      const a = (Array.isArray(raw) ? raw[0] : raw) as
        | { id?: string; nome?: string; cognome?: string; classe_sezione?: string | null }
        | undefined
      return {
        alunno_id: a?.id ?? '',
        nome: a?.nome ?? '',
        cognome: a?.cognome ?? '',
        classe_sezione: a?.classe_sezione ?? null,
        saldo_ticket: Number((r as { saldo_ticket?: number }).saldo_ticket ?? 0),
        ultimo_carico: (r as { ultimo_carico?: string | null }).ultimo_carico ?? null,
      }
    })
    return NextResponse.json({ success: true, data: rows })
  } catch (err) {
    console.error('Errore API GET ticket/morosi:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
