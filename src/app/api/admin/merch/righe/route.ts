import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { puoTransire, sincronizzaTestata, STATI_RIGA, type StatoRiga } from '@/lib/merch/stati'

// PATCH /api/admin/merch/righe — transizione manuale di una singola riga (fallback
// alle azioni dedicate: check-in/consegna/evasione). Enforce la macchina a stati.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const bodySchema = z.object({
  riga_id: zUuid,
  stato: z.enum(STATI_RIGA),
})
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { riga_id, stato } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type R = { id: string; stato: string; ordine_id: string; ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null }
    const { data: rigaRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, ordine:ordine_id ( scuola_id )')
      .eq('id', riga_id)
      .maybeSingle()
    if (error && SCHEMA_MANCANTE.has(error.code ?? '')) {
      return NextResponse.json({ error: 'Stato riga non disponibile su questo ambiente' }, { status: 503 })
    }
    const riga = rigaRaw as unknown as R | null
    if (!riga) return NextResponse.json({ error: 'Riga non trovata' }, { status: 404 })
    const sc = uno(riga.ordine)?.scuola_id
    if (!sc || !plessi.includes(sc)) return NextResponse.json({ error: 'Riga fuori dal tuo plesso' }, { status: 403 })

    const da = riga.stato as StatoRiga
    if (!puoTransire(da, stato)) {
      return NextResponse.json({ error: `Transizione non consentita: ${da} → ${stato}` }, { status: 409 })
    }

    const now = new Date().toISOString()
    const updates: Record<string, unknown> = { stato }
    if (stato === 'ordinato') updates.ordinato_il = now
    if (stato === 'arrivato') updates.arrivato_il = now
    if (stato === 'consegnato') { updates.consegnato_il = now; updates.consegnato_da = auth.user.id }
    if (stato === 'da_ordinare') { updates.ordine_fornitore_id = null; updates.ordinato_il = null }

    const { error: updErr } = await supabase.from('divise_ordini_righe').update(updates).eq('id', riga_id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

    await sincronizzaTestata(supabase, riga.ordine_id)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_riga',
      entitaId: riga_id,
      azione: 'update',
      scuolaId: sc,
      valorePrima: { stato: da },
      valoreDopo: { stato },
    })
    return NextResponse.json({ success: true, data: { riga_id, stato } })
  } catch (err) {
    console.error('Errore API PATCH merch/righe:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
