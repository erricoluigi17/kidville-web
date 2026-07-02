import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { vapidConfigured } from '@/lib/push/web-push'

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

    const body = await request.json()
    const sub = body.subscription
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return NextResponse.json({ error: 'subscription non valida' }, { status: 400 })
    }

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
    const { searchParams } = new URL(request.url)
    const endpoint = searchParams.get('endpoint')
    if (!endpoint) return NextResponse.json({ error: 'endpoint è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('utente_id', auth.user.id)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE subscribe:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
