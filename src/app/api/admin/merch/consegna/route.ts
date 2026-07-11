import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sincronizzaTestata } from '@/lib/merch/stati'
import { notificaMerchConsegnato } from '@/lib/merch/notify'

// POST /api/admin/merch/consegna — consegna all'alunno le righe ARRIVATE
// (arrivato → consegnato). Restituisce l'eventuale warning "pagamento non
// saldato" per ordine (NON bloccante). Notifica i genitori.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const bodySchema = z.object({ righe_ids: z.array(zUuid).min(1, 'Seleziona almeno una riga') })
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { righe_ids } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type Ord = {
      id?: string; scuola_id?: string | null; alunno_id?: string | null
      pagamento?: { stato?: string | null } | { stato?: string | null }[] | null
      alunni?: { nome?: string; cognome?: string } | { nome?: string; cognome?: string }[] | null
    }
    type R = { id: string; stato: string; ordine_id: string; articolo_nome: string; ordine: Ord | Ord[] | null }
    const { data: righeRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, articolo_nome, ordine:ordine_id ( id, scuola_id, alunno_id, pagamento:pagamento_id ( stato ), alunni:alunno_id ( nome, cognome ) )')
      .in('id', righe_ids)
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: { consegnate: 0, warnings: [], degraded: true } })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const righe = (righeRaw as unknown as R[]) ?? []
    if (righe.length !== righe_ids.length) return NextResponse.json({ error: 'Alcune righe non esistono' }, { status: 400 })
    for (const r of righe) {
      const sc = uno(r.ordine)?.scuola_id
      if (!sc || !plessi.includes(sc)) return NextResponse.json({ error: 'Righe fuori dal tuo plesso' }, { status: 403 })
    }
    if (righe.some((r) => r.stato !== 'arrivato')) {
      return NextResponse.json({ error: 'Solo le righe arrivate possono essere consegnate' }, { status: 409 })
    }

    const now = new Date().toISOString()
    // guard ottimistico: consegna SOLO le righe ancora 'arrivato' (anti-race)
    const { data: updatedRows, error: updErr } = await supabase
      .from('divise_ordini_righe')
      .update({ stato: 'consegnato', consegnato_il: now, consegnato_da: auth.user.id })
      .in('id', righe_ids)
      .eq('stato', 'arrivato')
      .select('id')
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
    // solo le righe realmente transitate (le altre erano già consegnate): niente
    // doppie notifiche/conteggi su doppio click o richieste concorrenti.
    const idOk = new Set((updatedRows ?? []).map((r) => r.id as string))
    const righeOk = righe.filter((r) => idOk.has(r.id))
    if (righeOk.length === 0) return NextResponse.json({ success: true, data: { consegnate: 0, warnings: [] } })

    await Promise.all([...new Set(righeOk.map((r) => r.ordine_id))].map((id) => sincronizzaTestata(supabase, id)))

    // Warning "non pagato" per ordine (non bloccante) + notifica per alunno.
    const warnings: { ordine_id: string; alunno: string; pagamento_stato: string }[] = []
    const perAlunno = new Map<string, { articoli: string[]; ordineId: string }>()
    const ordiniVisti = new Set<string>()
    for (const r of righeOk) {
      const o = uno(r.ordine)
      const stato = uno(o?.pagamento)?.stato ?? 'da_pagare'
      if (o?.id && !ordiniVisti.has(o.id)) {
        ordiniVisti.add(o.id)
        if (stato !== 'pagato') {
          const al = uno(o?.alunni)
          warnings.push({ ordine_id: o.id, alunno: `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim(), pagamento_stato: stato })
        }
      }
      const aid = o?.alunno_id
      if (aid) {
        const cur = perAlunno.get(aid) ?? { articoli: [], ordineId: r.ordine_id }
        cur.articoli.push(r.articolo_nome)
        perAlunno.set(aid, cur)
      }
    }
    for (const [alunnoId, info] of perAlunno) {
      await notificaMerchConsegnato(supabase, { alunnoId, articoli: info.articoli, ordineId: info.ordineId })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_consegna',
      entitaId: righe[0]?.ordine_id ?? 'consegna',
      azione: 'update',
      scuolaId: uno(righe[0]?.ordine)?.scuola_id ?? undefined,
      valoreDopo: { righe: righe_ids.length, stato: 'consegnato' },
    })

    return NextResponse.json({ success: true, data: { consegnate: righeOk.length, warnings } })
  } catch (err) {
    console.error('Errore API POST merch/consegna:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
