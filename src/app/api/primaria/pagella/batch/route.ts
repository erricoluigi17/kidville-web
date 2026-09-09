import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { generaPagella } from '@/lib/primaria/pagella-store'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Il nome della route, per i log. `withRoute` lo riceve come LETTERALE e non da
// qui: `__tests__/architecture/logging-coverage.test.ts` lo legge dal sorgente e
// verifica che corrisponda al percorso del file — con una costante non potrebbe.
const OP = 'primaria/pagella/batch:POST'

/** I due rifiuti «di merito» della route, da un punto solo (vedi `guastoDb`). */
function rifiuto(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status })
}

/**
 * Il guasto del DATABASE, distinto dai rifiuti qui sopra.
 *
 * PostgREST non lancia: la lettura degli alunni respinta lasciava `data === null`,
 * `?? []` la trasformava in «nessun alunno», il ciclo non girava nemmeno una volta
 * e la risposta era `{ success: true, generate: 0, totale: 0, errori: [] }` — cioè
 * un **200 che dice «fatto»** dove non è stata generata una sola pagella. Chi ha
 * premuto il pulsante non ha modo di distinguerlo da una classe vuota, e le
 * pagelle mancanti si scoprono quando le chiedono le famiglie.
 *
 * Sta in una funzione per lo stesso motivo di `rifiuto`: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` conta le risposte d'errore
 * senza `codice`, e questo file ne ha tre dichiarate in allowlist. Due rifiuti +
 * un guasto + il `catch` = tre punti di risposta, esattamente quanti prima.
 */
function guastoDb(esito: string, error: unknown): NextResponse {
  logEvento('db', 'error', { operazione: OP, esito }, error)
  return NextResponse.json({ error: 'Generazione delle pagelle non riuscita' }, { status: 500 })
}

const postBodySchema = z.object({
  scrutinioId: zUuid,
})

// POST /api/primaria/pagella/batch?userId=
// Genera e archivia in batch un PDF per OGNI alunno dello scrutinio (chiuso).
// La generazione è indipendente dalla pubblicazione ai genitori. Riservata alla
// dirigenza. body: { scrutinioId }
export const POST = withRoute('primaria/pagella/batch:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId } = b.data

    const supabase = await createAdminClient()

    const { data: scrutinio, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato')
      .eq('id', scrutinioId)
      .maybeSingle()
    // Una lettura respinta usciva come 404 «Scrutinio non trovato»: il guasto è
    // nostro, e va detto come tale invece di accusare chi ha cliccato.
    if (errScrutinio) return guastoDb('scrutinio-non-letto', errScrutinio)
    if (!scrutinio) return rifiuto('Scrutinio non trovato', 404)
    if (scrutinio.stato !== 'chiuso') return rifiuto('Generazione disponibile solo a scrutinio chiuso', 409)

    // Scoping di plesso per la dirigenza: batch solo su scrutini del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id as string)
    if (scopeErr) return scopeErr

    const { data: alunni, error: errAlunni } = await supabase.from('alunni').select('id').eq('section_id', scrutinio.section_id)
    // Il punto di tutta la route: senza l'elenco degli alunni non c'è un batch da
    // fare, c'è un batch che non si è POTUTO fare. Non è `totale: 0`.
    if (errAlunni) return guastoDb('alunni-non-letti', errAlunni)
    const alunniIds = (alunni ?? []).map((a) => a.id)

    let generate = 0
    const errori: { alunnoId: string; error: string }[] = []
    for (const alunnoId of alunniIds) {
      const { error } = await generaPagella(supabase, scrutinioId, alunnoId, auth.user.id, true)
      if (error) errori.push({ alunnoId, error })
      else generate++
    }

    return NextResponse.json({ success: true, generate, totale: alunniIds.length, errori })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
