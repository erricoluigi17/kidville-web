import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { sincronizzaTestata, poCompleto, type StatoRiga } from '@/lib/merch/stati'
import { notificaMerchArrivato } from '@/lib/merch/notify'

// POST /api/admin/merch/ordini-fornitore/checkin — check-in arrivi (anche parziali):
// le righe indicate passano 'ordinato' → 'arrivato'. Un PO viene chiuso quando
// TUTTE le sue righe non annullate sono arrivate/consegnate. Notifica ai genitori.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

const bodySchema = z.object({
  righe_ids: z.array(zUuid).min(1, 'Seleziona almeno una riga'),
})

const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

async function chiudiPOcompleti(supabase: SupabaseClient, poIds: string[]): Promise<void> {
  for (const poId of [...new Set(poIds)]) {
    if (!poId) continue
    const { data: righe } = await supabase.from('divise_ordini_righe').select('stato').eq('ordine_fornitore_id', poId)
    const stati = (righe ?? []).map((r) => String(r.stato) as StatoRiga)
    if (poCompleto(stati)) {
      await supabase.from('merch_ordini_fornitore').update({ stato: 'chiuso', chiuso_il: new Date().toISOString() }).eq('id', poId)
    }
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { righe_ids } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type R = {
      id: string; stato: string; ordine_id: string; ordine_fornitore_id: string | null; articolo_nome: string
      ordine: { scuola_id?: string | null; alunno_id?: string | null; alunni?: { nome?: string; cognome?: string } | { nome?: string; cognome?: string }[] | null } | { scuola_id?: string | null; alunno_id?: string | null }[] | null
    }
    const { data: righeRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, ordine_fornitore_id, articolo_nome, ordine:ordine_id ( scuola_id, alunno_id, alunni:alunno_id ( nome, cognome ) )')
      .in('id', righe_ids)
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: { arrivate: 0, degraded: true } })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const righe = (righeRaw as unknown as R[]) ?? []
    if (righe.length !== righe_ids.length) return NextResponse.json({ error: 'Alcune righe non esistono' }, { status: 400 })
    for (const r of righe) {
      const sc = uno(r.ordine)?.scuola_id
      if (!sc || !plessi.includes(sc)) return NextResponse.json({ error: 'Righe fuori dal tuo plesso' }, { status: 403 })
    }
    if (righe.some((r) => r.stato !== 'ordinato')) {
      return NextResponse.json({ error: 'Solo righe già ordinate possono essere ricevute (check-in)' }, { status: 409 })
    }

    const now = new Date().toISOString()
    // guard ottimistico: aggiorna SOLO le righe ancora 'ordinato' (anti-race)
    const { error: updErr } = await supabase.from('divise_ordini_righe').update({ stato: 'arrivato', arrivato_il: now }).in('id', righe_ids).eq('stato', 'ordinato')
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    // Chiudi i PO completi + sincronizza testate.
    await chiudiPOcompleti(supabase, righe.map((r) => r.ordine_fornitore_id ?? '').filter(Boolean))
    await Promise.all([...new Set(righe.map((r) => r.ordine_id))].map((id) => sincronizzaTestata(supabase, id)))

    // Notifica genitori (per alunno): raccogli gli articoli arrivati.
    const perAlunno = new Map<string, { articoli: string[]; ordineId: string }>()
    for (const r of righe) {
      const o = uno(r.ordine)
      const aid = o?.alunno_id
      if (!aid) continue
      const cur = perAlunno.get(aid) ?? { articoli: [], ordineId: r.ordine_id }
      cur.articoli.push(r.articolo_nome)
      perAlunno.set(aid, cur)
    }
    for (const [alunnoId, info] of perAlunno) {
      await notificaMerchArrivato(supabase, { alunnoId, articoli: info.articoli, ordineId: info.ordineId })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_checkin',
      entitaId: righe[0]?.ordine_fornitore_id ?? righe[0]?.id ?? 'checkin',
      azione: 'update',
      scuolaId: uno(righe[0]?.ordine)?.scuola_id ?? undefined,
      valoreDopo: { righe: righe_ids.length, stato: 'arrivato' },
    })

    return NextResponse.json({ success: true, data: { arrivate: righe_ids.length } })
  } catch (err) {
    console.error('Errore API POST merch/ordini-fornitore/checkin:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
