import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import {
  CASSA_BUCKET,
  CASSA_MAX_BYTES,
  CASSA_MAX_MB,
  CASSA_MIME_AMMESSI,
  ensureCassaBucket,
  pathGiustificativo,
} from '@/lib/cassa/store'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// MODULO CASSA · URL firmato di upload del giustificativo (contratto §3.4/§3.5).
//
// Upload DIRETTO client→storage sul bucket PRIVATO `cassa-giustificativi`: il
// client fa PUT del file sull'URL firmato, poi passa `allegato_path` alla POST
// /cassa/movimenti. La foto è FACOLTATIVA (decisione #6): un fallimento qui non
// deve bloccare la registrazione del movimento (lo gestisce la UI).
// Pattern clonato da admin/protocolli/upload-url.
// =============================================================================

const postBodySchema = z.object({
  nome: z.string().min(1).max(200),
  mime: z.enum(CASSA_MIME_AMMESSI, { error: 'Formato non ammesso: sono accettati JPG, PNG, WEBP e PDF' }),
  size: z.coerce.number().int().min(1).max(CASSA_MAX_BYTES, `File troppo grande (max ${CASSA_MAX_MB} MB)`),
  scuola_id: zUuid,
})

export const POST = withRoute('pagamenti/cassa/allegato/upload-url:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const rl = rateLimit(`cassa-upload:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppi caricamenti. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sede = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, b.data.scuola_id)
    if (sede.response) return sede.response
    const scuolaId = sede.scuolaId as string

    await ensureCassaBucket(supabase)

    const path = pathGiustificativo(scuolaId, b.data.nome)
    const { data, error } = await supabase.storage.from(CASSA_BUCKET).createSignedUploadUrl(path)
    if (error || !data?.signedUrl || !data.token) {
      logErrore({ operazione: 'pagamenti/cassa/allegato/upload-url:POST', stato: 500, evento: 'storage' }, error)
      return NextResponse.json(
        { error: `Preparazione upload non riuscita: ${error?.message ?? 'URL mancante'}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ path, token: data.token, signedUrl: data.signedUrl })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/cassa/allegato/upload-url:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
