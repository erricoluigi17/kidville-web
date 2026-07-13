import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { vapidConfigured } from '@/lib/push/web-push'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// L'eventuale `userId` nel body/header e' ignorato: si usa sempre l'utente autenticato.
// Due varianti: Web Push (subscription VAPID) oppure token NATIVO (Capacitor iOS/Android).
const webSchema = z.object({
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
const nativeSchema = z.object({
  token: z.string().min(1, 'token non valido'),
  platform: z.enum(['ios', 'android']),
})
const postBodySchema = z.union([webSchema, nativeSchema])

const deleteQuerySchema = z.object({
  endpoint: z.string({ error: 'endpoint è obbligatorio' }).min(1, 'endpoint è obbligatorio'),
})

// POST /api/push/subscribe  — registra la subscription push dell'utente autenticato.
// Body web:    { subscription: { endpoint, keys: { p256dh, auth } } }
// Body nativo: { token, platform: 'ios' | 'android' }
export const POST = withRoute('push/subscribe:POST', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const userAgent = request.headers.get('user-agent') ?? null

    if ('token' in body) {
      // Token nativo (FCM/APNs). Il gating dell'INVIO e' a dispatch time: qui
      // registriamo sempre il token, cosi' e' pronto quando FCM sara' configurato.
      // Il token nativo occupa la colonna `endpoint` (chiave di upsert); p256dh/auth
      // (specifici del Web Push) restano NULL.
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          utente_id: user.id,
          endpoint: body.token,
          p256dh: null,
          auth: null,
          platform: body.platform,
          user_agent: userAgent,
        },
        { onConflict: 'endpoint' }
      )
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, platform: body.platform }, { status: 201 })
    }

    // Web Push (VAPID). Registrare una subscription che non potra' mai ricevere
    // push e' fuorviante: 503 chiaro finche' le chiavi VAPID non sono configurate.
    if (!vapidConfigured()) {
      return NextResponse.json(
        { error: 'configurazione mancante: VAPID (push web non configurato)' },
        { status: 503 }
      )
    }

    const sub = body.subscription
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        utente_id: user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        platform: 'web',
        user_agent: userAgent,
      },
      { onConflict: 'endpoint' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'push/subscribe:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/push/subscribe?endpoint=...  — rimuove la subscription (web o nativa:
// per i token nativi `endpoint` contiene il token stesso).
export const DELETE = withRoute('push/subscribe:DELETE', async (request: Request) => {
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
    logErrore({ operazione: 'push/subscribe:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
