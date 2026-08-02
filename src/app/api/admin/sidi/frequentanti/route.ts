import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { buildFrequentanti } from '@/lib/sidi/payload'
import { serializeFrequentanti } from '@/lib/sidi/serializer'
import { sidiTransmit } from '@/lib/sidi/client'
import { loadSyncState, persistFaseStato } from '@/lib/sidi/sync-store'
import { puoInviareFrequentanti } from '@/lib/sidi/sequenza'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `scuola_id`: la sede di cui si trasmette l'elenco frequentanti. Fino al
// 2026-07-31 non esisteva, e `resolveScuolaScrittura` veniva chiamata SENZA
// `preferita`: per l'admin multi-plesso ripiegava in silenzio sulla sede
// primaria, cioè si spediva al Ministero l'elenco di Giugliano mentre si
// lavorava su Aversa. Ora la sede si dichiara — o si riceve un 400.
const postQuerySchema = z.object({ scuola_id: zUuid.optional() })

// POST /api/admin/sidi/frequentanti?userId=&scuola_id=  — Invio flusso frequentanti.
// Sequenza: consentito solo dopo Fase A `inviato` (altrimenti 409). Egress GATED.
export const POST = withRoute('admin/sidi/frequentanti:POST', async (request: NextRequest) => {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response
    try {
      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, q.data.scuola_id ?? undefined)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId!

      const state = await loadSyncState(supabase, scuolaId)
      if (!puoInviareFrequentanti(state.fase_a_stato)) {
        return NextResponse.json(
          { error: 'Allineamento Fase A non ancora inviato: i frequentanti vanno trasmessi dopo la struttura', stato: state.fase_a_stato },
          { status: 409 }
        )
      }

      const { data: sezioni, error: errSezioni } = await supabase.from('sections').select('id, name').eq('scuola_id', scuolaId)
      const { data: alunni, error: errAlunni } = await supabase
        .from('alunni')
        .select('id, section_id, codice_fiscale, nome, cognome, stato')
        .eq('scuola_id', scuolaId)
      const { data: settings, error: errSettings } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()

      // PostgREST non lancia: senza questo controllo una lettura fallita
      // diventerebbe un flusso VUOTO trasmesso al Ministero e marcato `inviato`.
      // Meglio un 500 rumoroso che un allineamento silenziosamente sbagliato.
      const errLettura = errSezioni ?? errAlunni ?? errSettings
      if (errLettura) {
        logEvento('sidi', 'error', { operazione: 'admin/sidi/frequentanti:POST', tipo: 'frequentanti', esito: 'lettura-fallita' }, errLettura)
        return NextResponse.json({ error: 'Lettura dei dati di sede non riuscita: trasmissione annullata' }, { status: 500 })
      }

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
      logErrore({ operazione: 'admin/sidi/frequentanti:POST', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})
