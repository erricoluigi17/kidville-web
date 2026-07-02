import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { buildFaseAReconcile } from '@/lib/sidi/payload'
import { serializeFaseA } from '@/lib/sidi/serializer'
import { sidiTransmit } from '@/lib/sidi/client'
import { persistFaseStato } from '@/lib/sidi/sync-store'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postQuerySchema = z.object({}) // nessun parametro in ingresso (il body non viene letto; userId è consumato dal gate)

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

// POST /api/admin/sidi/fase-a?userId=  — Allineamento strutturale (Fase A).
// Build neutro (sezioni + tempo scuola) → serialize → trasmissione GATED.
// Riservato alla dirigenza. Egress reale subordinato all'accreditamento (503).
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  const q = parseQuery(request, postQuerySchema)
  if ('response' in q) return q.response
  try {
    const supabase = await createAdminClient()
    const scuolaId = auth.user.scuola_id || SCUOLA_ID_DEFAULT

    const { data: scuola } = await supabase.from('schools').select('id, nome').eq('id', scuolaId).maybeSingle()
    const { data: sezioni } = await supabase.from('sections').select('id, name, school_type').eq('scuola_id', scuolaId)
    const { data: tempo } = await supabase.from('tempo_scuola').select('section_id, modello, giorni_settimana, attivo')
    const { data: settings } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()

    const flusso = buildFaseAReconcile({
      sedi: scuola ? [{ id: scuola.id, nome: scuola.nome }] : [],
      sezioni: (sezioni ?? []) as { id: string; name: string; school_type: string }[],
      tempoScuola: (tempo ?? []) as { section_id: string; modello: number; giorni_settimana: number; attivo: boolean }[],
    })
    const xml = serializeFaseA(flusso)

    const result = await sidiTransmit((settings?.sidi_config as Record<string, unknown>) ?? {}, 'fase_a', xml)
    const stato = result.ok ? 'inviato' : 'errore'
    await persistFaseStato(supabase, scuolaId, 'fase_a', stato, result)

    if (!result.ok) return NextResponse.json({ ...result, stato }, { status: result.httpStatus })
    return NextResponse.json({ success: true, stato, sezioni: flusso.sezioni.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
