import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { sendOtp } from '@/lib/auth/otp-ticket'
import { logFeaEvent } from '@/lib/fea/audit'
import { extractRequestMeta } from '@/lib/fea/signature-log'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// L'identità viene dalla SESSIONE (`requireUser`), mai dalla query: `?userId=` è
// ignorato. Fino al 2026-07-31 leggeva `getRequestUserId` in diretta, scavalcando
// `ALLOW_HEADER_IDENTITY=false`: l'invio dell'OTP alla casella del genitore era
// azionabile da chiunque ne conoscesse l'uuid, senza sessione e senza limite.
// Lock: __tests__/api/firma-identita-da-sessione.test.ts.
const postQuerySchema = z.object({}) // nessun parametro in ingresso

// POST /api/parent/primaria/note/firma/otp?userId=
// Invia un OTP via email al genitore per firmare la presa visione di una nota.
export const POST = withRoute('parent/primaria/note/firma/otp:POST', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, userId, {
      subject: 'Codice di conferma presa visione nota — Kidville',
      intro: 'Il tuo codice per confermare la presa visione della nota è',
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })

    const { ip, userAgent } = extractRequestMeta(request)
    await logFeaEvent(supabase, { entitaTipo: 'nota', signerUserId: userId, email: res.email, evento: 'otp_sent', ip, userAgent })

    return NextResponse.json({ success: true, data: res })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/note/firma/otp:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
