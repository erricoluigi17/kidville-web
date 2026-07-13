import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  modelId: zUuid,
  userId: zUuid.nullish(),
  // Pass-through jsonb { field_id → valore }: oggi è accettato qualsiasi
  // valore truthy (vecchio guard `!data`), nessun vincolo sul contenuto.
  data: z.unknown().refine((v) => !!v, 'data è obbligatorio'),
})

// Submission SENZA firma (status `completed`) del Sistema A `form_models`.
// Sostituisce l'insert client-side del wizard (rotto: il client browser è anon e
// la RLS di `form_submissions` richiede sessione Supabase Auth). Service-role +
// scoping app, coerente con `send-otp`. Registra lo snapshot consensi (DL-029).

export const POST = withRoute('forms/submit:POST', async (request: Request) => {
  const rl = rateLimit(`forms-submit:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { modelId, userId } = b.data
    const data = b.data.data as FormSubmissionData

    const supabase = await createAdminClient()

    // Sospensione moroso (DL-021): inibisce nuove compilazioni di moduli.
    if (userId) {
      const sospesoErr = await assertGenitoreNonSospeso(supabase, userId)
      if (sospesoErr) return sospesoErr
    }

    // Carica lo schema del modello per snapshot consensi + guard server-side.
    const { data: model } = await supabase
      .from('form_models')
      .select('schema, title')
      .eq('id', modelId)
      .maybeSingle()
    const pages = ((model?.schema as FormSchemaConfig | undefined)?.pages) ?? []

    const mancanti = consensiObbligatoriMancanti(pages, data as Record<string, unknown>)
    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Consensi obbligatori non accettati', missing: mancanti },
        { status: 400 }
      )
    }

    const acceptedAt = new Date().toISOString()
    const consents_log = estraiConsensi(pages, data as Record<string, unknown>, acceptedAt)

    const { data: submission, error: insertErr } = await supabase
      .from('form_submissions')
      .insert({
        model_id: modelId,
        user_id: userId ?? null,
        data,
        status: 'completed',
        consents_log: consents_log.length > 0 ? consents_log : null,
      })
      .select('id')
      .single()

    if (insertErr || !submission) {
      return NextResponse.json(
        { error: insertErr instanceof Error ? insertErr.message : 'Creazione submission fallita' },
        { status: 500 }
      )
    }

    // Notifica alla segreteria: modulo compilato (best-effort). Debounce per
    // modello + buffer 60' → una notifica riassuntiva, non una per invio.
    try {
      let scuolaId: string | null = null
      if (userId) {
        const { data: u } = await supabase.from('utenti').select('scuola_id').eq('id', userId).maybeSingle()
        scuolaId = (u?.scuola_id as string | undefined) ?? null
      }
      if (!scuolaId) scuolaId = await scuolaUnicaReale(supabase)
      const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
      await notificaEvento(supabase, {
        tipo: 'modulo_compilato',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Modulo compilato ricevuto',
        corpo: `Ci sono nuove compilazioni per «${(model as { title?: string } | null)?.title ?? 'un modulo'}».`,
        link: '/admin/modulistica',
        entitaTipo: 'form_model',
        entitaId: modelId,
        bufferMin: 60,
        debounce: true,
      })
    } catch (e) {
      console.error('Notifica modulo compilato fallita (non bloccante):', e)
    }

    return NextResponse.json({ id: submission.id }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'forms/submit:POST', stato: 500 }, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
})
