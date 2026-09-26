import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// scuola_id è advisory: lo scoping reale viene da resolveScuoleAttive (cookie/plessi).
const getQuerySchema = z.object({ scuola_id: zUuid.optional() })

// GET /api/pagamenti/ticket/morosi?userId=&scuola_id=
//   staff (incl. segreteria): alunni con saldo ticket NEGATIVO nelle sedi attive.
//   ticket_mensa non ha scuola_id → join !inner su alunni per lo scoping (no leak).
//   Ogni riga porta `scuola_id` (quella dell'ALUNNO, che è la sede vera) e `scuola_nome`
//   (K5, 2026-09-26): con tre plessi l'elenco deve dire a quale cassa mandare la famiglia.
export const GET = withRoute('pagamenti/ticket/morosi:GET', async (request: NextRequest) => {
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
    if (error) {
      logErrore({ operazione: 'pagamenti/ticket/morosi:GET', stato: 500 }, error)
      return NextResponse.json({ error: 'Errore caricamento morosi ticket', codice: 'LETTURA_FALLITA' }, { status: 500 })
    }

    const base = (data ?? []).map((r) => {
      const raw = (r as { alunni?: unknown }).alunni
      const a = (Array.isArray(raw) ? raw[0] : raw) as
        | { id?: string; nome?: string; cognome?: string; classe_sezione?: string | null; scuola_id?: string | null }
        | undefined
      return {
        alunno_id: a?.id ?? '',
        nome: a?.nome ?? '',
        cognome: a?.cognome ?? '',
        classe_sezione: a?.classe_sezione ?? null,
        scuola_id: a?.scuola_id ?? null,
        saldo_ticket: Number((r as { saldo_ticket?: number }).saldo_ticket ?? 0),
        ultimo_carico: (r as { ultimo_carico?: string | null }).ultimo_carico ?? null,
      }
    })

    // I NOMI delle sedi: una lettura sola, sulle sole sedi che compaiono nelle righe (già
    // dentro il perimetro della query sopra, quindi nessun plesso in più). Best-effort: se
    // fallisce, la riga resta con la sua `scuola_id` e `scuola_nome` null — e si dice.
    const idsSede = [...new Set(base.map((r) => r.scuola_id).filter((x): x is string => !!x))]
    const nomi = new Map<string, string>()
    if (idsSede.length > 0) {
      const { data: sedi, error: errSedi } = await supabase.from('scuole').select('id, nome').in('id', idsSede)
      if (errSedi) {
        logEvento('pagamento', 'warn', {
          operazione: 'pagamenti/ticket/morosi:GET',
          esito: 'nomi_sede_non_letti',
          sedi: idsSede.length,
        }, errSedi)
      } else {
        for (const s of (sedi ?? []) as { id: string; nome: string | null }[]) {
          if (s.nome) nomi.set(s.id, s.nome)
        }
      }
    }
    const rows = base.map((r) => ({ ...r, scuola_nome: r.scuola_id ? nomi.get(r.scuola_id) ?? null : null }))
    return NextResponse.json({ success: true, data: rows })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ticket/morosi:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
