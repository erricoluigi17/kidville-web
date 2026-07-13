import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { translateText } from '@/lib/translate/claude'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// text/targetLang: oggi qualsiasi valore truthy è accettato e poi convertito con
// String(...) prima della chiamata a translateText; lo schema replica esattamente
// quel comportamento senza aggiungere vincoli di tipo.
const zTruthy = z.unknown().refine((v) => Boolean(v), 'Campo obbligatorio')
const postBodySchema = z.object({
  text: zTruthy,
  targetLang: zTruthy,
})

// POST /api/chat/translate — traduzione automatica di un messaggio chat (DL-042).
// Gated (qualsiasi utente autenticato) + rate-limit anti-abuso. Delega a
// `translateText` (Claude haiku); 503 se il servizio non è configurato (manca
// ANTHROPIC_API_KEY) così l'UI può nascondere/disabilitare il pulsante.
export const POST = withRoute('chat/translate:POST', async (request: Request) => {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const rl = rateLimit(`chat-translate:${clientIp(request)}`, { limit: 60, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste di traduzione. Riprova tra poco.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    )
  }

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response

  try {
    const res = await translateText(String(b.data.text), String(b.data.targetLang))
    if (res.disabled) {
      return NextResponse.json(
        { disabled: true, error: 'Traduzione non configurata (chiave assente)' },
        { status: 503 },
      )
    }
    if (res.translated == null) {
      return NextResponse.json({ error: 'Traduzione non riuscita' }, { status: 502 })
    }
    return NextResponse.json({ translated: res.translated })
  } catch (err) {
    logErrore({ operazione: 'chat/translate:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
