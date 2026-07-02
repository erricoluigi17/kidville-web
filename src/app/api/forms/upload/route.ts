import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseData } from '@/lib/validation/http'

// Upload generico di un allegato di un modello (Sistema A `form_models`).
// Service-role + scoping app (decisione DL-029): bucket privato `form_attachments`,
// nessuna policy storage. Ripara l'upload del wizard AUTENTICATO (il client browser
// è anonimo e non può scrivere su bucket deny-by-default). Variante pubblica
// token-scoped: slice "Pubblica modello".

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il file si valida come presenza/istanza (il contenuto non è materia di zod).
// max_size_mb resta permissivo: oggi QUALSIASI valore non numerico ricade sul
// default (`Number(...) || DEFAULT_MAX_MB`), quindi niente coerce numerica.
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
  folder: z.string().nullish(),
  max_size_mb: z.unknown().optional(),
})

const DEFAULT_MAX_MB = 8
const ALLOWED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'])
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
])

export async function POST(request: Request) {
  // Autenticazione (qualsiasi ruolo): impedisce upload anonimi sul bucket privato.
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  // Anti-abuso: upload ripetuti per IP.
  const rl = rateLimit(`forms-upload:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppi caricamenti. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    const form = await request.formData()
    const parsed = parseData(postFormSchema, {
      file: form.get('file'),
      folder: form.get('folder'),
      max_size_mb: form.get('max_size_mb'),
    })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data
    const folder = (parsed.data.folder || 'generico').replace(/[^a-zA-Z0-9._-]/g, '_')

    const maxMb = Number(parsed.data.max_size_mb) || DEFAULT_MAX_MB
    if (file.size > maxMb * 1024 * 1024) {
      return NextResponse.json({ error: `File troppo grande (max ${maxMb}MB)` }, { status: 400 })
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const mimeOk = !file.type || ALLOWED_MIME.has(file.type)
    if (!ALLOWED_EXT.has(ext) || !mimeOk) {
      return NextResponse.json(
        { error: 'Tipo di file non ammesso (PDF o immagini)' },
        { status: 400 }
      )
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `models/${folder}/${crypto.randomUUID()}-${safeName}`

    const supabase = await createAdminClient()
    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage
      .from('form_attachments')
      .upload(path, arrayBuffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'application/octet-stream',
      })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ path })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
