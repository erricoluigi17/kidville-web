import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { buildGenitoriAlunni } from '@/lib/sidi/payload'
import { serializeGenitoriAlunni } from '@/lib/sidi/serializer'
import { sidiTransmit } from '@/lib/sidi/client'
import { loadSyncState, persistFaseStato } from '@/lib/sidi/sync-store'
import { puoInviarePiattaformaUnica } from '@/lib/sidi/sequenza'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `scuola_id`: la sede di cui si trasmettono le associazioni. Vedi la nota in
// `frequentanti/route.ts`: senza, l'admin multi-plesso ripiegava in silenzio
// sulla sede primaria.
const postQuerySchema = z.object({ scuola_id: zUuid.optional() })

type NestedCf = { codice_fiscale?: string | null } | { codice_fiscale?: string | null }[] | null
type NestedPf = { fiscal_code?: string | null } | { fiscal_code?: string | null }[] | null
const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v)

// POST /api/admin/sidi/piattaforma-unica?userId=&scuola_id=  — Flusso associazioni Genitori-Alunni.
// Solo legami VALIDATI dalla Segreteria. Sequenza: dopo frequentanti `inviato`. GATED.
export const POST = withRoute('admin/sidi/piattaforma-unica:POST', async (request: NextRequest) => {
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
      if (!puoInviarePiattaformaUnica(state.frequentanti_stato)) {
        return NextResponse.json(
          { error: 'Flusso frequentanti non ancora inviato: le associazioni vanno trasmesse dopo i frequentanti', stato: state.frequentanti_stato },
          { status: 409 }
        )
      }

      // ISOLAMENTO FRA SEDI (2026-07-31). Questa query non aveva NESSUN filtro di
      // plesso: al Ministero, sotto il codice meccanografico di una sola scuola,
      // partivano i legami genitore↔figlio (codici fiscali di minori e adulti) di
      // TUTTE e tre le sedi. `alunni!inner` + il filtro sull'embedded è la stessa
      // forma già in produzione in `admin/sidi/legami:GET`.
      const { data: rows, error: errLegami } = await supabase
        .from('student_parents')
        .select('relation_type, validato_sidi, alunni!inner(codice_fiscale, scuola_id), parents(fiscal_code)')
        .eq('alunni.scuola_id', scuolaId)
        .eq('validato_sidi', true)
      const { data: settings, error: errSettings } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()

      // PostgREST non lancia: una lettura fallita diventerebbe un flusso VUOTO
      // trasmesso e marcato `inviato`, cioè «associazioni: nessuna» detto al
      // Ministero per errore nostro.
      const errLettura = errLegami ?? errSettings
      if (errLettura) {
        logEvento('sidi', 'error', { operazione: 'admin/sidi/piattaforma-unica:POST', tipo: 'piattaforma_unica', esito: 'lettura-fallita' }, errLettura)
        return NextResponse.json({ error: 'Lettura dei legami di sede non riuscita: trasmissione annullata' }, { status: 500 })
      }

      const legami = ((rows ?? []) as unknown as { relation_type: string; alunni: NestedCf; parents: NestedPf }[]).map((r) => ({
        student_cf: one(r.alunni)?.codice_fiscale ?? null,
        parent_cf: one(r.parents)?.fiscal_code ?? null,
        relation_type: r.relation_type,
        validato: true,
      }))
      const flusso = buildGenitoriAlunni({ legami })
      const xml = serializeGenitoriAlunni(flusso)

      const result = await sidiTransmit((settings?.sidi_config as Record<string, unknown>) ?? {}, 'piattaforma_unica', xml)
      const stato = result.ok ? 'inviato' : 'errore'
      await persistFaseStato(supabase, scuolaId, 'piattaforma_unica', stato, result)

      if (!result.ok) return NextResponse.json({ ...result, stato }, { status: result.httpStatus })
      return NextResponse.json({ success: true, stato, associazioni: flusso.associazioni.length })
    } catch (err) {
      logErrore({ operazione: 'admin/sidi/piattaforma-unica:POST', stato: 500 }, err)
      const msg = err instanceof Error ? err.message : 'Errore interno'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
})
