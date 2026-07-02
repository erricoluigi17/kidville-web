import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'

// Upload generico di un allegato di un modello (Sistema A `form_models`).
// Service-role + scoping app (decisione DL-029): bucket privato `form_attachments`,
// nessuna policy storage. Ripara l'upload del wizard AUTENTICATO (il client browser
// è anonimo e non può scrivere su bucket deny-by-default). Variante pubblica
// token-scoped: slice "Pubblica modello".

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
    const file = form.get('file') as File | null
    const folder = ((form.get('folder') as string | null) || 'generico').replace(/[^a-zA-Z0-9._-]/g, '_')

    if (!file) {
      return NextResponse.json({ error: 'Nessun file ricevuto' }, { status: 400 })
    }

    const maxMb = Number(form.get('max_size_mb')) || DEFAULT_MAX_MB
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
