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

// Nessun parametro in ingresso: l'identità viene dalla SESSIONE (`requireUser`),
// `?userId=` è ignorato. Fino al 2026-07-31 leggeva `getRequestUserId` in diretta,
// scavalcando `ALLOW_HEADER_IDENTITY=false`: l'invio dell'OTP alla casella del
// genitore era azionabile da chiunque ne conoscesse l'uuid.
// Lock: __tests__/api/firma-identita-da-sessione.test.ts.
const querySchema = z.object({})

// POST /api/parent/primaria/pagella/firma/otp?userId=
// Invia un OTP via email al genitore per firmare la ricezione della pagella.
export const POST = withRoute('parent/primaria/pagella/firma/otp:POST', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const q = parseQuery(request, querySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, userId, {
      subject: 'Codice di conferma ricezione pagella — Kidville',
      intro: 'Il tuo codice per confermare la ricezione della pagella è',
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })

    const { ip, userAgent } = extractRequestMeta(request)
    await logFeaEvent(supabase, { entitaTipo: 'pagella', signerUserId: userId, email: res.email, evento: 'otp_sent', ip, userAgent })

    return NextResponse.json({ success: true, data: res })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/pagella/firma/otp:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
