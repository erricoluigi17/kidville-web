import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { assertGenitoreNonSospesoSalvoEssenziale } from '@/lib/pagamenti/sospensione'
import { leggiSempreFirmabile } from '@/lib/forms/sempre-firmabile'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
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

    // Sospensione moroso (DL-021): inibisce nuove compilazioni di moduli, salvo
    // i moduli essenziali (sempre_firmabile: salute/sicurezza).
    if (userId) {
      const sempreFirmabile = await leggiSempreFirmabile(supabase, 'form_models', modelId)
      const sospesoErr = await assertGenitoreNonSospesoSalvoEssenziale(supabase, userId, { sempreFirmabile })
      if (sospesoErr) return sospesoErr
    }

    // Carica lo schema del modello per snapshot consensi + guard server-side.
    const { data: model } = await supabase
      .from('form_models')
      // `scuola_id` serve a dare una sede alla compilazione quando chi compila
      // non ne ha una propria (link pubblico, genitore senza plesso).
      .select('schema, title, scuola_id')
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

    // Sede della COMPILAZIONE, scritta all'invio. Era calcolata già qui sotto,
    // ma solo per decidere a chi mandare la notifica — e poi buttata via: la riga
    // restava senza sede, e nessun elenco poteva più filtrarla. Ordine di
    // risoluzione: la sede di chi compila → quella dichiarata sul modello →
    // l'unica sede reale (se ce n'è una sola). Se resta ambigua si scrive `null`
    // e la riga è visibile alla sola Direzione: inventarle una sede sarebbe
    // peggio che ammettere di non saperla.
    let scuolaId: string | null = null
    if (userId) {
      const { data: u } = await supabase.from('utenti').select('scuola_id').eq('id', userId).maybeSingle()
      scuolaId = (u?.scuola_id as string | undefined) ?? null
    }
    if (!scuolaId) scuolaId = (model as { scuola_id?: string | null } | null)?.scuola_id ?? null
    if (!scuolaId) scuolaId = await scuolaUnicaReale(supabase)

    const rigaInvio: Record<string, unknown> = {
      model_id: modelId,
      user_id: userId ?? null,
      data,
      status: 'completed',
      consents_log: consents_log.length > 0 ? consents_log : null,
      scuola_id: scuolaId,
    }
    let insRes = await supabase.from('form_submissions').insert(rigaInvio).select('id').single()
    // DB E2E della CI non migrato: la colonna `scuola_id` non c'è ancora
    // (PGRST204/42703). Si riprova senza — quel database ha una sede sola, quindi
    // non c'è nessun isolamento da riaprire.
    if (insRes.error && ['PGRST204', '42703'].includes((insRes.error as { code?: string }).code ?? '')) {
      logEvento('modulistica', 'info', {
        operazione: 'forms/submit:POST', esito: 'colonna-sede-assente-degrado',
      })
      delete rigaInvio.scuola_id
      insRes = await supabase.from('form_submissions').insert(rigaInvio).select('id').single()
    }
    const { data: submission, error: insertErr } = insRes

    if (insertErr || !submission) {
      return NextResponse.json(
        { error: insertErr instanceof Error ? insertErr.message : 'Creazione submission fallita' },
        { status: 500 }
      )
    }

    // Notifica alla segreteria: modulo compilato (best-effort). Debounce per
    // modello + buffer 60' → una notifica riassuntiva, non una per invio.
    try {
      // Stessa sede appena scritta sulla riga: la notifica va allo staff di QUEL
      // plesso, non a quello di tutti.
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
      // `error` benché il modulo sia registrato (201): la segreteria non viene avvisata, quindi
      // una compilazione arrivata resta lì finché qualcuno non apre la modulistica per caso.
      // La riga c'è, il suo annuncio no: scrittura persa, non dettaglio saltato.
      logEvento('notifica', 'error', {
        operazione: 'forms/submit:POST',
        esito: 'notifica-segreteria-non-accodata',
      }, e)
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
