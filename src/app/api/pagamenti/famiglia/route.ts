import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { saldoCredito } from '@/lib/pagamenti/credito'
import { residuoEffettivo, statoEffettivo, type AgingPagamento } from '@/lib/pagamenti/aging'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Dati di famiglia per la transazione unica (slice S4 — Contabilità v2) ─────
// A partire da parents.id: figli (unione legami), voci aperte con residuo effettivo
// ordinate per scadenza ASC (più vecchie prima → «proposta automatica»), saldo
// credito famiglia, saldo ticket mensa per figlio. Tutto in sola lettura (staff).

const getQuerySchema = z.object({ parent_id: zUuid })

const round2 = (n: number) => Math.round(n * 100) / 100

const SEL_VOCI = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, sconto, scadenza, stato, tipo, categoria_id, gruppo, periodo_competenza, parent_payment_id'
const SEL_VOCI_BASE = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, scadenza, stato, tipo, categoria_id, gruppo, periodo_competenza, parent_payment_id'

interface VoceRow extends AgingPagamento {
  id: string
  alunno_id: string
  scuola_id?: string | null
  descrizione?: string | null
  [k: string]: unknown
}

export const GET = withRoute('pagamenti/famiglia:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const parentId = q.data.parent_id

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)

    const { data: parent, error: pErr } = await supabase
      .from('parents')
      .select('id, first_name, last_name, auth_user_id')
      .eq('id', parentId)
      .maybeSingle()
    if (pErr) {
      logErrore({ operazione: 'pagamenti/famiglia:GET', stato: 500, evento: 'db' }, pErr)
      return NextResponse.json({ error: 'Errore nel recupero del genitore' }, { status: 500 })
    }
    if (!parent) return NextResponse.json({ error: 'Genitore non trovato' }, { status: 404 })
    const p = parent as { id: string; first_name?: string | null; last_name?: string | null; auth_user_id?: string | null }

    // Saldo credito: sempre disponibile (anche per genitore senza figli).
    const credito = await saldoCredito(supabase, parentId)

    // Figli: unione (student_parents diretto su parents.id) + (unione legami via
    // account, se il genitore ha un auth_user_id). Copre anche i genitori SENZA account.
    const childIds = new Set<string>()
    const { data: sp } = await supabase.from('student_parents').select('student_id').eq('parent_id', p.id)
    for (const r of (sp ?? []) as { student_id?: string | null }[]) if (r.student_id) childIds.add(r.student_id)
    if (p.auth_user_id) {
      for (const f of await getFigliDiGenitore(supabase, p.auth_user_id)) childIds.add(f)
    }

    const nome = [p.first_name, p.last_name].filter(Boolean).join(' ')
    if (childIds.size === 0) {
      return NextResponse.json({ success: true, data: { parent: { id: p.id, nome }, figli: [], voci: [], credito } })
    }

    // Alunni (limitati allo scope di sede dello staff).
    const { data: alunniRows } = await supabase
      .from('alunni')
      .select('id, nome, cognome, scuola_id')
      .in('id', [...childIds])
    const alunni = ((alunniRows ?? []) as { id: string; nome?: string | null; cognome?: string | null; scuola_id?: string | null }[])
      .filter((a) => !a.scuola_id || sedi.length === 0 || sedi.includes(String(a.scuola_id)))
    const scopedIds = alunni.map((a) => a.id)

    if (scopedIds.length === 0) {
      return NextResponse.json({ success: true, data: { parent: { id: p.id, nome }, figli: [], voci: [], credito } })
    }

    // Saldo ticket mensa per figlio.
    const { data: ticketRows } = await supabase
      .from('ticket_mensa')
      .select('alunno_id, saldo_ticket')
      .in('alunno_id', scopedIds)
    const ticketMap = new Map<string, number>()
    for (const t of (ticketRows ?? []) as { alunno_id: string; saldo_ticket?: number | null }[]) {
      ticketMap.set(t.alunno_id, Number(t.saldo_ticket ?? 0))
    }
    const figli = alunni.map((a) => ({ id: a.id, nome: a.nome ?? null, cognome: a.cognome ?? null, saldo_ticket: ticketMap.get(a.id) ?? 0 }))

    // Voci aperte: SELECT con `sconto`, retry senza su DB non migrato (42703).
    let res = await supabase.from('pagamenti').select(SEL_VOCI).in('alunno_id', scopedIds)
    if (res.error && (res.error as { code?: string }).code === '42703') {
      res = (await supabase.from('pagamenti').select(SEL_VOCI_BASE).in('alunno_id', scopedIds)) as typeof res
    }
    if (res.error) {
      logErrore({ operazione: 'pagamenti/famiglia:GET', stato: 500, evento: 'db' }, res.error)
      return NextResponse.json({ error: 'Errore nel recupero delle voci' }, { status: 500 })
    }
    const oggi = new Date().toISOString().slice(0, 10)
    const voci = ((res.data ?? []) as VoceRow[])
      .filter((v) => v.tipo !== 'padre')
      .map((v) => ({ ...v, residuo: round2(residuoEffettivo(v)), stato_effettivo: statoEffettivo(v, oggi) }))
      .filter((v) => v.residuo > 0)
      // Più vecchie prima: la «proposta automatica» alloca in quest'ordine.
      .sort((a, b) => String(a.scadenza ?? '9999-12-31').localeCompare(String(b.scadenza ?? '9999-12-31')))

    return NextResponse.json({ success: true, data: { parent: { id: p.id, nome }, figli, voci, credito } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/famiglia:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
