import { oggiRoma, istanteNelGiornoRoma } from '@/lib/storici/retroattivita'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { puoTransire, sincronizzaTestata, STATI_RIGA, type StatoRiga } from '@/lib/merch/stati'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// PATCH /api/admin/merch/righe — transizione manuale di una singola riga (fallback
// alle azioni dedicate: check-in/consegna/evasione). Enforce la macchina a stati.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const bodySchema = z.object({ giorno_competenza: zDataYMD.refine(g => g <= oggiRoma(), 'Data futura non consentita').optional(),
  riga_id: zUuid,
  stato: z.enum(STATI_RIGA),
})
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export const PATCH = withRoute('admin/merch/righe:PATCH', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, bodySchema)
    if ('response' in b) return b.response
    const { riga_id, stato } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)

    type R = { id: string; stato: string; ordine_id: string; ordinato_il?: string | null; arrivato_il?: string | null; consegnato_il?: string | null; ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null }
    const { data: rigaRaw, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, stato, ordine_id, ordinato_il, arrivato_il, consegnato_il, ordine:ordine_id ( scuola_id )')
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
    const rettificaData = da === stato && !!b.data.giorno_competenza && ['ordinato', 'arrivato', 'consegnato'].includes(da)
    if (!rettificaData && !puoTransire(da, stato)) {
      return NextResponse.json({ error: `Transizione non consentita: ${da} → ${stato}` }, { status: 409 })
    }

    const now = b.data.giorno_competenza ? istanteNelGiornoRoma(b.data.giorno_competenza) : new Date().toISOString()
    const updates: Record<string, unknown> = { stato }
    if (stato === 'ordinato') updates.ordinato_il = now
    if (stato === 'arrivato') updates.arrivato_il = now
    if (stato === 'consegnato') { updates.consegnato_il = now; if (!rettificaData) updates.consegnato_da = auth.user.id }
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
      valorePrima: { stato: da, ordinato_il: riga.ordinato_il ?? null, arrivato_il: riga.arrivato_il ?? null, consegnato_il: riga.consegnato_il ?? null },
      valoreDopo: { ...updates, giorno_competenza: b.data.giorno_competenza ?? oggiRoma() },
    })
    return NextResponse.json({ success: true, data: { riga_id, stato } })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/righe:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
