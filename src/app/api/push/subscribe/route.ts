import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { vapidConfigured } from '@/lib/push/web-push'
import { parseBody, parseQuery } from '@/lib/validation/http'

// L'eventuale `userId` nel body è ignorato: si usa sempre l'utente autenticato.
const postBodySchema = z.object({
  subscription: z.object(
    {
      endpoint: z.string().min(1, 'subscription non valida'),
      keys: z.object(
        {
          p256dh: z.string().min(1, 'subscription non valida'),
          auth: z.string().min(1, 'subscription non valida'),
        },
        { error: 'subscription non valida' }
      ),
    },
    { error: 'subscription non valida' }
  ),
})

const deleteQuerySchema = z.object({
  endpoint: z.string({ error: 'endpoint è obbligatorio' }).min(1, 'endpoint è obbligatorio'),
})

// POST /api/push/subscribe  — registra la subscription Web Push dell'utente
// Body: { userId, subscription: { endpoint, keys: { p256dh, auth } } }
export async function POST(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    // Registrare una subscription che non potrà mai ricevere push è fuorviante:
    // meglio un 503 chiaro finché le chiavi VAPID non sono configurate.
    if (!vapidConfigured()) {
      return NextResponse.json(
        { error: 'configurazione mancante: VAPID (push web non configurato)' },
        { status: 503 }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const sub = b.data.subscription

    const supabase = await createAdminClient()
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        utente_id: user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: request.headers.get('user-agent') ?? null,
      },
      { onConflict: 'endpoint' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST subscribe:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/push/subscribe?endpoint=...&userId=  — rimuove la subscription
export async function DELETE(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { endpoint } = q.data

    const supabase = await createAdminClient()
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('utente_id', auth.user.id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE subscribe:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
