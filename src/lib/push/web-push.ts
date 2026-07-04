import webpush from 'web-push'

let configured = false

/** true se le chiavi VAPID sono presenti (il push web è configurabile). */
export function vapidConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

function ensureConfigured(): boolean {
  if (configured) return true
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:info@kidville.it'
  if (!pub || !priv) return false
  webpush.setVapidDetails(subject, pub, priv)
  configured = true
  return true
}

export interface PushSub {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

/**
 * Invia una notifica Web Push. Ritorna { ok } oppure { ok:false, gone } se la
 * subscription è scaduta (410/404) e va rimossa. Senza chiavi VAPID degrada
 * senza lanciare: { ok:false, error:'vapid_non_configurato' }.
 */
export async function sendPush(sub: PushSub, payload: PushPayload): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  if (!ensureConfigured()) return { ok: false, error: 'vapid_non_configurato' }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    )
    return { ok: true }
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode
    if (statusCode === 410 || statusCode === 404) return { ok: false, gone: true }
    return { ok: false, error: (err as Error)?.message }
  }
}
