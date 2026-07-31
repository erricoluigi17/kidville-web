import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { colonnaSedeAssente, degradoSedeLecito } from '@/lib/forms/degrado-sede'
import { calcolaDelibera, type EsitoAmmissione } from '@/lib/forms/delibera'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const ESITI_VALIDI = ['ammesso', 'lista_attesa', 'non_ammesso'] as const satisfies readonly EsitoAmmissione[]

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il body ha due forme (override singolo vs delibera bulk) discriminate dalla
// PRESENZA di submissionId: prima un parse loose del body, poi lo schema del
// ramo scelto (così i campi dell'altro ramo restano ignorati come prima).
const postBodySchema = z.looseObject({
  submissionId: z.unknown().optional(),
  modelId: z.unknown().optional(),
})

const postOverrideSchema = z.object({
  submissionId: zUuid,
  esito: z.enum(ESITI_VALIDI),
  note: z.unknown().optional(), // usato solo se stringa (comportamento invariato)
})

const postBulkSchema = z.object({
  modelId: zUuid,
  posti: z.unknown().optional(), // coercizione Number() nel handler (default 0)
  soglia: z.unknown().optional(), // coercizione Number() nel handler (default 0)
})

// POST /api/forms/delibera  (staff) — delibera ammissioni (DL-025).
//  • bulk:     { modelId, posti, soglia }  → calcola e assegna gli esiti
//  • override: { submissionId, esito, note? } → forza l'esito di un candidato
export const POST = withRoute('forms/delibera:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const parsed = await parseBody(request, postBodySchema)
    if ('response' in parsed) return parsed.response
    const body = parsed.data

    const supabase = await createAdminClient()
    const nowIso = new Date().toISOString()

    // Ammettere, mettere in lista d'attesa o non ammettere è una DECISIONE sulle
    // famiglie, non una lettura: fino al 2026-07-31 questa route non aveva
    // nessun vincolo di sede e la segreteria di un plesso deliberava sulle
    // domande di qualunque altro. Il filtro sta sulla SELECT dei candidati e
    // sull'UPDATE, in AND: il primo evita che l'omonimia del modello porti
    // dentro le domande dell'altra sede, il secondo che si nomini una singola
    // domanda altrui per id. Scope vuoto ⇒ nessuna domanda, mai «tutte».
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)

    // ── Override singolo ──
    if (body.submissionId) {
      const o = parseData(postOverrideSchema, body)
      if ('response' in o) return o.response
      const { submissionId, esito, note } = o.data

      const leggiSede = (conSede: boolean) => {
        let q = supabase.from('form_submissions').select('id, scuola_id').eq('id', submissionId)
        if (conSede) q = q.in('scuola_id', plessi)
        return q.maybeSingle()
      }
      let conSede = true
      let sedeRes = await leggiSede(true)
      if (colonnaSedeAssente(sedeRes.error)) {
        if (!(await degradoSedeLecito(supabase, 'forms/delibera:POST'))) {
          return NextResponse.json({ error: 'Isolamento per sede non disponibile' }, { status: 500 })
        }
        conSede = false
        sedeRes = await leggiSede(false)
      }
      if (sedeRes.error) {
        logEvento('modulistica', 'error', {
          operazione: 'forms/delibera:POST', esito: 'domanda-non-letta',
        }, sedeRes.error)
        return NextResponse.json({ error: sedeRes.error.message }, { status: 500 })
      }
      // 404 e non 403: la risposta non deve distinguere «non è tua» da «non
      // esiste», o diventa un oracolo sull'esistenza delle domande altrui.
      if (!sedeRes.data) {
        return NextResponse.json({ error: 'Compilazione non trovata' }, { status: 404 })
      }

      // Il filtro di sede si ripete sull'UPDATE, non solo sulla lettura: fra il
      // controllo e la scrittura c'è comunque una finestra, e il costo di
      // chiuderla è una clausola.
      let upd = supabase
        .from('form_submissions')
        .update({
          esito_ammissione: esito,
          esito_il: nowIso,
          esito_da: auth.user.id,
          esito_note: typeof note === 'string' ? note : null,
        })
        .eq('id', submissionId)
      if (conSede) upd = upd.in('scuola_id', plessi)
      const { error } = await upd
      if (error) {
        logEvento('modulistica', 'error', {
          operazione: 'forms/delibera:POST', esito: 'esito-non-scritto', entita_id: submissionId,
        }, error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      // Successo loggato: un esito di ammissione è una decisione su una famiglia.
      logEvento('modulistica', 'info', {
        operazione: 'forms/delibera:POST', esito: 'esito-forzato', entita_id: submissionId,
      })
      return NextResponse.json({ success: true, data: { submissionId, esito } })
    }

    // ── Delibera bulk ──
    const bulk = parseData(postBulkSchema, body)
    if ('response' in bulk) return bulk.response
    const posti = Math.max(0, Number(bulk.data.posti ?? 0))
    const soglia = Number(bulk.data.soglia ?? 0)

    const leggiCandidati = (conSede: boolean) => {
      let q = supabase
        .from('form_submissions')
        .select('id, score')
        .eq('model_id', bulk.data.modelId)
        .eq('status', 'completed')
      if (conSede) q = q.in('scuola_id', plessi)
      return q.order('score', { ascending: false })
    }
    let candidatiRes = await leggiCandidati(true)
    if (colonnaSedeAssente(candidatiRes.error)) {
      if (!(await degradoSedeLecito(supabase, 'forms/delibera:POST'))) {
        return NextResponse.json({ error: 'Isolamento per sede non disponibile' }, { status: 500 })
      }
      candidatiRes = await leggiCandidati(false)
    }
    if (candidatiRes.error) {
      // PostgREST non lancia: senza questo controllo un guasto di lettura
      // diventerebbe «zero candidati», cioè una delibera vuota dichiarata riuscita.
      logEvento('modulistica', 'error', {
        operazione: 'forms/delibera:POST', esito: 'candidati-non-letti',
      }, candidatiRes.error)
      return NextResponse.json({ error: candidatiRes.error.message }, { status: 500 })
    }

    const candidati = ((candidatiRes.data ?? []) as { id: string; score: number }[]).map((s) => ({
      id: s.id,
      score: Number(s.score ?? 0),
    }))
    const esiti = calcolaDelibera(candidati, { soglia, posti })

    for (const e of esiti) {
      const { error: updErr } = await supabase
        .from('form_submissions')
        .update({ esito_ammissione: e.esito, esito_il: nowIso, esito_da: auth.user.id })
        .eq('id', e.id)
      if (updErr) {
        logEvento('modulistica', 'error', {
          operazione: 'forms/delibera:POST', esito: 'esito-non-scritto', entita_id: e.id,
        }, updErr)
        return NextResponse.json({ error: updErr.message }, { status: 500 })
      }
    }

    const conteggi = esiti.reduce<Record<string, number>>((acc, e) => {
      acc[e.esito] = (acc[e.esito] ?? 0) + 1
      return acc
    }, {})

    // Successo loggato, non solo l'errore: una delibera è una decisione sulle
    // famiglie e «zero righe deliberate» dev'essere distinguibile da «non è mai
    // partita». Solo conteggi e uuid: nessun dato di minore.
    logEvento('modulistica', 'info', {
      operazione: 'forms/delibera:POST', esito: 'delibera-eseguita',
      totale: esiti.length, sedi: plessi.length,
    })

    return NextResponse.json({ success: true, data: { totale: esiti.length, conteggi } })
  } catch (err) {
    logErrore({ operazione: 'forms/delibera:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
