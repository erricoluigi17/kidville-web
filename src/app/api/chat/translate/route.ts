import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-staff'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { translateText } from '@/lib/translate/claude'

// POST /api/chat/translate — traduzione automatica di un messaggio chat (DL-042).
// Gated (qualsiasi utente autenticato) + rate-limit anti-abuso. Delega a
// `translateText` (Claude haiku); 503 se il servizio non è configurato (manca
// ANTHROPIC_API_KEY) così l'UI può nascondere/disabilitare il pulsante.
export async function POST(request: Request) {
  const auth = await requireUser(request)
  if (auth.response) return auth.response

  const rl = rateLimit(`chat-translate:${clientIp(request)}`, { limit: 60, windowMs: 10 * 60 * 1000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste di traduzione. Riprova tra poco.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    )
  }

  try {
    const body = await request.json()
    const text = body?.text
    const targetLang = body?.targetLang
    if (!text || !targetLang) {
      return NextResponse.json({ error: 'text e targetLang sono obbligatori' }, { status: 400 })
    }

    const res = await translateText(String(text), String(targetLang))
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
    console.error('Errore POST /api/chat/translate:', err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
}
