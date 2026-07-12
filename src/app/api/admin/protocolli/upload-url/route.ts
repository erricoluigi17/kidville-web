import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import {
  MIME_AMMESSI,
  PROTOCOLLO_BUCKET,
  PROTOCOLLO_MAX_BYTES,
  PROTOCOLLO_MAX_MB,
  ensureBucket,
  pathStaging,
} from '@/lib/protocolli/store'
import { rispostaErroreProtocollo } from '@/lib/protocolli/server'

// URL firmato di upload DIRETTO client→storage (staging): aggira il limite di
// body (~4,5 MB) di Vercel per file fino a 25 MB (decisione #7). Il client fa
// PUT del file sull'URL firmato, poi chiama /analizza e infine POST /protocolli.

const postBodySchema = z.object({
  nome: z.string().min(1).max(200),
  mime: z.enum(MIME_AMMESSI, { error: 'Formato non ammesso: sono accettati PDF, JPG e PNG' }),
  size: z.coerce
    .number()
    .int()
    .min(1)
    .max(PROTOCOLLO_MAX_BYTES, `File troppo grande (max ${PROTOCOLLO_MAX_MB} MB)`),
  scopo: z.enum(['principale', 'allegato']).default('principale'),
})

export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response

    const rl = rateLimit(`protocolli-upload:${clientIp(request)}`, {
      limit: 30,
      windowMs: 10 * 60 * 1000,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppi caricamenti. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    await ensureBucket(supabase)

    const path = pathStaging(b.data.nome)
    const { data, error } = await supabase.storage.from(PROTOCOLLO_BUCKET).createSignedUploadUrl(path)
    if (error || !data?.signedUrl || !data.token) {
      return NextResponse.json(
        { error: `Preparazione upload non riuscita: ${error?.message ?? 'URL mancante'}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: { path, token: data.token, signedUrl: data.signedUrl },
    })
  } catch (err) {
    console.error('Errore API POST protocolli/upload-url:', err)
    return rispostaErroreProtocollo(err)
  }
}
