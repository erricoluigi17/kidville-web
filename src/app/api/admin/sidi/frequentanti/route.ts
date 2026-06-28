import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { buildFrequentanti } from '@/lib/sidi/payload'
import { serializeFrequentanti } from '@/lib/sidi/serializer'
import { sidiTransmit } from '@/lib/sidi/client'
import { loadSyncState, persistFaseStato } from '@/lib/sidi/sync-store'
import { puoInviareFrequentanti } from '@/lib/sidi/sequenza'

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

// POST /api/admin/sidi/frequentanti?userId=  — Invio flusso frequentanti.
// Sequenza: consentito solo dopo Fase A `inviato` (altrimenti 409). Egress GATED.
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  try {
    const supabase = await createAdminClient()
    const scuolaId = auth.user.scuola_id || SCUOLA_ID_DEFAULT

    const state = await loadSyncState(supabase, scuolaId)
    if (!puoInviareFrequentanti(state.fase_a_stato)) {
      return NextResponse.json(
        { error: 'Allineamento Fase A non ancora inviato: i frequentanti vanno trasmessi dopo la struttura', stato: state.fase_a_stato },
        { status: 409 }
      )
    }

    const { data: sezioni } = await supabase.from('sections').select('id, name').eq('scuola_id', scuolaId)
    const { data: alunni } = await supabase
      .from('alunni')
      .select('id, section_id, codice_fiscale, nome, cognome, stato')
      .eq('scuola_id', scuolaId)
    const { data: settings } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()

    const flusso = buildFrequentanti({
      sezioni: (sezioni ?? []) as { id: string; name: string }[],
      alunni: (alunni ?? []) as { id: string; section_id: string | null; codice_fiscale: string | null; nome: string; cognome: string; stato: string }[],
    })
    const xml = serializeFrequentanti(flusso)

    const result = await sidiTransmit((settings?.sidi_config as Record<string, unknown>) ?? {}, 'frequentanti', xml)
    const stato = result.ok ? 'inviato' : 'errore'
    await persistFaseStato(supabase, scuolaId, 'frequentanti', stato, result)

    if (!result.ok) return NextResponse.json({ ...result, stato }, { status: result.httpStatus })
    return NextResponse.json({ success: true, stato, classi: flusso.perClasse.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
