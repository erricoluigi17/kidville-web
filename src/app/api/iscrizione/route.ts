import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { validatePage, isProvinceField } from '@/lib/forms/validate-fields'
import {
  extractEnrollmentTemplates,
  STANDARD_ENROLLMENT_MODEL_ID,
} from '@/lib/forms/enrollment-default-schema'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import type {
  EnrollmentSubmissionData,
  FormField,
  FormSchemaConfig,
} from '@/types/database.types'

// Carica i template child/adult del "Modulo d'iscrizione standard" dal DB, così
// la validazione server segue lo schema che la segreteria può aver modificato nel
// builder. FALLBACK ai template in codice (CHILD_FIELDS/ADULT_FIELDS) se il modello
// non è caricabile — è anche ciò che rende pulito il degrado sul DB E2E della CI,
// che il modello standard non ce l'ha (PostgREST ritorna { error }, non lancia).
async function caricaTemplate(
  supabase: SupabaseClient,
): Promise<{ child: FormField[]; adult: FormField[] }> {
  try {
    const { data, error } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', STANDARD_ENROLLMENT_MODEL_ID)
      .maybeSingle()
    if (error) {
      logEvento('forms', 'info', {
        operazione: 'iscrizione:POST',
        esito: 'fallback_template_codice',
        error_code: error.code,
      }, error)
      return extractEnrollmentTemplates(null)
    }
    return extractEnrollmentTemplates((data?.schema ?? null) as FormSchemaConfig | null)
  } catch (e) {
    logEvento('forms', 'info', {
      operazione: 'iscrizione:POST',
      esito: 'fallback_template_codice',
    }, e)
    return extractEnrollmentTemplates(null)
  }
}

/**
 * Normalizza le province di un record PRIMA della validazione: "Napoli" → "NA",
 * "na" → "NA". Un valore irriconoscibile resta com'è (così `validateField`
 * segnala il pattern) e uno vuoto/facoltativo non viene toccato.
 */
function normalizzaRecord(rec: unknown, fields: FormField[]): Record<string, unknown> {
  const r: Record<string, unknown> =
    rec !== null && typeof rec === 'object' && !Array.isArray(rec)
      ? { ...(rec as Record<string, unknown>) }
      : {}
  for (const f of fields) {
    if (!isProvinceField(f)) continue
    const raw = r[f.id]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    const sigla = normalizzaProvincia(raw)
    if (sigla) r[f.id] = sigla
  }
  return r
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` viene inserito INTERO nella colonna JSONB enrollment_submissions.data:
// .loose() preserva le chiavi extra del wizard. Gli elementi di children/adults
// restano liberi (oggi nessun vincolo sulla loro forma).
// `scuola_id` resta unknown: oggi QUALSIASI valore falsy (assente, '', null, …)
// ricade sul default, gestito nel codice con || come prima.
const postBodySchema = z.object({
  scuola_id: z.unknown().optional(),
  data: z
    .object(
      {
        children: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un bambino'),
        adults: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un adulto'),
      },
      { error: 'Dati iscrizione non validi' }
    )
    .loose(),
})

// POST: il genitore invia l'iscrizione dal form pubblico (service-role).
export const POST = withRoute('iscrizione:POST', async (request: NextRequest) => {
  try {
    // Rotta pubblica → rate-limit anti-abuso (5 invii / 10 min per IP).
    const rl = rateLimit(`iscrizione:${clientIp(request)}`, { limit: 5, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { data } = b.data

    const supabase = await createAdminClient()

    // ── Ri-validazione SERVER-SIDE dei campi contro il modello ──────────────
    // Il client valida già, ma il POST è pubblico: qui è l'ultima difesa prima
    // che un dato malformato (es. una provincia per esteso) arrivi al DB e rompa
    // l'import a valle. Normalizza le province, poi valida ogni record.
    const { child: childFields, adult: adultFields } = await caricaTemplate(supabase)
    const campi: {
      children?: Record<string, Record<string, string>>
      adults?: Record<string, Record<string, string>>
    } = {}
    const camposFalliti: string[] = []

    const normalizza = (
      lista: unknown,
      fields: FormField[],
      gruppo: 'children' | 'adults',
    ): Record<string, unknown>[] => {
      const arr = Array.isArray(lista) ? lista : []
      return arr.map((rec, i) => {
        const r = normalizzaRecord(rec, fields)
        const errs = validatePage(fields, r)
        if (Object.keys(errs).length > 0) {
          ;(campi[gruppo] ??= {})[String(i)] = errs
          for (const idCampo of Object.keys(errs)) camposFalliti.push(`${gruppo}.${i}.${idCampo}`)
        }
        return r
      })
    }

    const children = normalizza(data.children, childFields, 'children')
    const adults = normalizza(data.adults, adultFields, 'adults')

    if (camposFalliti.length > 0) {
      // warn: la difesa ha funzionato ma qualcosa è passato dal client malformato
      // (bug del client o invio fuori dal wizard). Solo id campo e indice nel log —
      // MAI i valori: sono dati di minori. Il path finisce in `messaggio` (non PII).
      logEvento('iscrizione', 'warn', {
        operazione: 'iscrizione:POST',
        esito: 'campi-non-validi',
        msg: `Iscrizione respinta: ${camposFalliti.join(', ')}`,
        n: camposFalliti.length,
      })
      return NextResponse.json(
        { error: 'Alcuni campi non sono validi. Controlla i dati e riprova.', campi },
        { status: 400 },
      )
    }

    // Salva i dati NORMALIZZATI (province già ridotte a sigla).
    const dataNormalizzata = { ...(data as Record<string, unknown>), children, adults }

    // Scuola dell'iscrizione: dal link (?scuola=) se indicata e valida; altrimenti
    // la scuola REALE del deployment. La scuola di test E2E (id e2e00000…) è
    // esclusa dalla risoluzione automatica, così in prod (E2E + reale) si sceglie
    // sempre quella reale. Con più scuole reali e nessuna indicata → 400.
    const { data: scuole } = await supabase.from('schools').select('id, nome')
    const tutte = (scuole ?? []) as { id: string; nome: string }[]
    const richiesta = (b.data.scuola_id as string | undefined) || undefined
    let scuolaId: string | undefined
    if (richiesta && tutte.some((s) => s.id === richiesta)) {
      scuolaId = richiesta
    } else {
      const isE2E = (s: { id: string; nome: string }) =>
        s.id.startsWith('e2e00000') || /e2e/i.test(s.nome)
      const reali = tutte.filter((s) => !isE2E(s))
      if (reali.length === 1) scuolaId = reali[0].id
      else if (tutte.length === 1) scuolaId = tutte[0].id
    }
    if (!scuolaId) {
      return NextResponse.json({ error: 'Specificare la scuola per l\'iscrizione' }, { status: 400 })
    }

    const { data: row, error } = await supabase
      .from('enrollment_submissions')
      .insert({
        scuola_id: scuolaId,
        data: dataNormalizzata as EnrollmentSubmissionData,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Notifica alla segreteria: nuova domanda dal form pubblico (best-effort).
    try {
      const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
      await notificaEvento(supabase, {
        tipo: 'iscrizione_ricevuta',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Nuova domanda di iscrizione',
        corpo: 'È arrivata una nuova pre-iscrizione dal form pubblico.',
        link: '/admin/iscrizioni',
        entitaTipo: 'iscrizione',
        entitaId: row.id,
        bufferMin: 0,
      })
    } catch (e) {
      // `error` benché la domanda sia registrata (201): la segreteria non viene avvisata, e una
      // pre-iscrizione che nessuno sa di aver ricevuto è una famiglia che resta senza risposta.
      // La riga c'è, il suo annuncio è perso: scrittura persa, non dettaglio saltato.
      logEvento('notifica', 'error', {
        operazione: 'iscrizione:POST',
        esito: 'notifica-segreteria-non-accodata',
      }, e)
    }

    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'iscrizione:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
  }
})
