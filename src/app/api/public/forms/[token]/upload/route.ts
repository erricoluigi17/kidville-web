import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import {
  FINESTRA_UPLOAD_PUBBLICO_MS,
  TETTO_UPLOAD_PUBBLICO,
  rispostaTroppiCaricamenti,
  verificaAllegatoPubblico,
} from '@/lib/upload/allegati-pubblici'

// Upload allegato ANONIMO per un modello pubblicato (DL-030). Token-scoped, service-role.
//
// I TIPI AMMESSI NON VIVONO PIÙ QUI (2026-08-02, sicurezza F1). Erano scritti in questo file
// e mancavano del tutto sulla rotta gemella `iscrizione/upload`, che scrive nello STESSO
// bucket: la stessa regola su due strade, applicata a una sola. Ora sta in
// `@/lib/upload/allegati-pubblici`, insieme al tetto per IP — e il bucket dichiara la
// medesima lista in migrazione, così le tre dichiarazioni non possono divergere in silenzio.

const DEFAULT_MAX_MB = 8

// Il token pubblico è una stringa opaca (usata su form_models.public_token), non un uuid.
const tokenParamSchema = z.string().min(1)

// max_size_mb: oggi qualsiasi valore non numerico ricade sul default (`Number(x) || 8`);
// `.catch(undefined)` preserva quel comportamento invece di rispondere 400.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
  max_size_mb: z.coerce.number().optional().catch(undefined),
})

export const POST = withRoute('public/forms/[token]/upload:POST', async (
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) => {
  const rl = rateLimit(`public-upload:${clientIp(request)}`, {
    limit: TETTO_UPLOAD_PUBBLICO,
    windowMs: FINESTRA_UPLOAD_PUBBLICO_MS,
  })
  if (!rl.ok) return rispostaTroppiCaricamenti(rl.retryAfterMs)

  try {
    const rawParams = await params
    const tk = parseData(tokenParamSchema, rawParams.token)
    if ('response' in tk) return tk.response
    const token = tk.data

    const supabase = await createAdminClient()

    // Il token deve corrispondere a un modello pubblicato (anti-abuso storage).
    const { data: model } = await supabase
      .from('form_models')
      .select('id, published_at')
      .eq('public_token', token)
      .maybeSingle()
    if (!model || !model.published_at) {
      return NextResponse.json({ error: 'Modulo non trovato o non pubblicato' }, { status: 404 })
    }

    // Content-Type sbagliato = errore del CLIENT: 400 (e non l'eccezione al `catch`).
    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const parsed = parseData(postFormSchema, {
      file: form.data.get('file') ?? undefined,
      max_size_mb: form.data.get('max_size_mb') ?? undefined,
    })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data

    const maxMb = parsed.data.max_size_mb || DEFAULT_MAX_MB
    if (file.size > maxMb * 1024 * 1024) {
      return NextResponse.json({ error: `File troppo grande (max ${maxMb}MB)` }, { status: 400 })
    }

    // Il gate sui tipi è lo stesso di `iscrizione/upload` — stesso bucket, stessa regola,
    // un modulo solo. Il 415 sostituisce il 400 di prima: è il codice che dice «il file non
    // va bene», non «la richiesta è malformata», ed è quello che le rotte degli allegati
    // interni usano già dal 2026-07-31.
    const gate = verificaAllegatoPubblico(file, {
      operazione: 'public/forms/[token]/upload:POST',
      bucket: 'form_attachments',
    })
    if (!gate.ok) return gate.risposta

    const safeToken = token.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `public/${safeToken}/${crypto.randomUUID()}-${safeName}`

    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage
      .from('form_attachments')
      .upload(path, arrayBuffer, {
        cacheControl: '3600',
        upsert: false,
        // Il tipo NORMALIZZATO dal gate, mai `application/octet-stream`: col bucket che
        // dichiara i suoi tipi ammessi, un allegato valido verrebbe altrimenti respinto
        // DOPO essere stato caricato, con un 500 che non spiega niente.
        contentType: gate.contentType,
      })
    if (error) {
      // Il corpo dell'errore del fornitore resta nel LOG (AGENTS §3) e non torna al client:
      // qui il chiamante è ANONIMO, e quel testo porta fuori bucket, vincoli e policy.
      logErrore({ operazione: 'public/forms/[token]/upload:POST', stato: 500, evento: 'storage' }, error)
      return rispostaAllegatoNonCaricato()
    }
    return NextResponse.json({ path })
  } catch (err) {
    logErrore({ operazione: 'public/forms/[token]/upload:POST', stato: 500 }, err)
    return rispostaAllegatoNonCaricato()
  }
})
