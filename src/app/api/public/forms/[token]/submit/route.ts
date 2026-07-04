import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { accessoConsentito } from '@/lib/forms/publish'
import { parseBody, parseData } from '@/lib/validation/http'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

// Submission ANONIMA di un modello pubblicato (DL-030). Token-scoped, service-role.
// Solo `completed` (la firma OTP pubblica è materia della slice firma congiunta).

// Il token pubblico è una stringa opaca (usata su form_models.public_token), non un uuid.
const tokenParamSchema = z.string().min(1)

// `data` è il payload libero della submission: oggi è accettato qualsiasi valore
// truthy (il codice controllava solo `!data`), quindi resta volutamente permissivo.
const postBodySchema = z.object({
  data: z.unknown().refine((v) => Boolean(v), { message: 'data obbligatorio' }),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const rl = rateLimit(`public-submit:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    const rawParams = await params
    const tk = parseData(tokenParamSchema, rawParams.token)
    if ('response' in tk) return tk.response
    const token = tk.data

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const data = b.data.data as FormSubmissionData

    const supabase = await createAdminClient()
    const { data: model } = await supabase
      .from('form_models')
      .select('id, published_at, access_mode, schema')
      .eq('public_token', token)
      .maybeSingle()

    if (!model || !model.published_at) {
      return NextResponse.json({ error: 'Modulo non trovato o non pubblicato' }, { status: 404 })
    }
    // L'accesso pubblico anonimo è consentito solo in modalità `public`.
    if (!accessoConsentito(model, false)) {
      return NextResponse.json({ error: 'Accesso riservato agli utenti registrati' }, { status: 403 })
    }

    const pages = ((model.schema as FormSchemaConfig | undefined)?.pages) ?? []
    const mancanti = consensiObbligatoriMancanti(pages, data as Record<string, unknown>)
    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Consensi obbligatori non accettati', missing: mancanti },
        { status: 400 }
      )
    }

    const consents_log = estraiConsensi(pages, data as Record<string, unknown>, new Date().toISOString())
    const { data: submission, error } = await supabase
      .from('form_submissions')
      .insert({
        model_id: model.id,
        user_id: null,
        data,
        status: 'completed',
        consents_log: consents_log.length > 0 ? consents_log : null,
      })
      .select('id')
      .single()

    if (error || !submission) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invio fallito' },
        { status: 500 }
      )
    }
    return NextResponse.json({ id: submission.id }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
