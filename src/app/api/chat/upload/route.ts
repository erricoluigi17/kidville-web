import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseData } from '@/lib/validation/http'

// Upload allegato chat (M5.5): bucket privato `chat-allegati`, scritture solo
// via service-role (come le altre route chat — nessuna policy storage).
// Risponde con un URL firmato a TTL lungo: viene salvato così com'è in
// chat_messages.attachment_url e riletto dal render esistente
// (ChatMessageArea usa l'URL direttamente).

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
})

const BUCKET = 'chat-allegati'
const MAX_MB = 10
// TTL 1 anno: l'URL firmato è persistito nel messaggio; oltre la scadenza
// l'allegato non è più raggiungibile (limite noto dello slice M5.5).
const SIGNED_TTL_S = 60 * 60 * 24 * 365

const ALLOWED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif'])
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/gif',
])

export async function POST(request: Request) {
  // Autenticazione (qualsiasi ruolo): impedisce upload anonimi sul bucket privato.
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  // Anti-abuso: upload ripetuti per IP.
  const rl = rateLimit(`chat-upload:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppi caricamenti. Riprova tra qualche minuto.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    )
  }

  try {
    const form = await request.formData()
    const parsed = parseData(postFormSchema, { file: form.get('file') })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data

    if (file.size > MAX_MB * 1024 * 1024) {
      return NextResponse.json({ error: `File troppo grande (max ${MAX_MB}MB)` }, { status: 400 })
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
    const path = `${auth.user.id}/${crypto.randomUUID()}-${safeName}`

    const supabase = await createAdminClient()
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, await file.arrayBuffer(), {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'application/octet-stream',
      })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_TTL_S)
    if (signErr || !signed?.signedUrl) {
      return NextResponse.json({ error: signErr?.message ?? 'Firma URL non riuscita' }, { status: 500 })
    }

    return NextResponse.json({
      url: signed.signedUrl,
      attachment_type: file.type.startsWith('image/') ? 'image' : 'document',
      name: file.name,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Errore interno' },
      { status: 500 }
    )
  }
}
