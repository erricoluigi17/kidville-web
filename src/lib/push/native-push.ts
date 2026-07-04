import crypto from 'node:crypto'

// =============================================================================
// Push NATIVE (Capacitor iOS/Android) via Firebase Cloud Messaging HTTP v1.
//
// GATED sulle credenziali service-account Firebase (FCM_PROJECT_ID /
// FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY). Senza credenziali NON lancia: degrada
// come web-push.ts (pattern M2) restituendo { ok:false, error:'fcm_non_configurato' }.
// Il token nativo viene comunque registrato lato subscribe, cosi' che appena FCM
// sara' configurato le nuove notifiche partiranno.
//
// Copertura: Android (token FCM) e iOS (token FCM, con la APNs Auth Key caricata
// dentro Firebase — vedi docs/mobile.md). L'egress reale e' subordinato a un
// progetto Firebase accreditato: la verifica live e' a carico del committente.
// =============================================================================

export type NativePlatform = 'ios' | 'android'

/** true se le credenziali FCM sono presenti (la push nativa e' inviabile). */
export function fcmConfigured(): boolean {
  return Boolean(
    process.env.FCM_PROJECT_ID &&
      process.env.FCM_CLIENT_EMAIL &&
      process.env.FCM_PRIVATE_KEY
  )
}

export interface NativePushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

// Cache per-processo dell'access token OAuth (validita' ~1h).
let cachedToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt - 60 > nowSec) return cachedToken.value

  const clientEmail = process.env.FCM_CLIENT_EMAIL as string
  // Negli env la private key ha spesso i newline "escaped" (\n): normalizziamo.
  const privateKey = String(process.env.FCM_PRIVATE_KEY).replace(/\\n/g, '\n')

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  ).toString('base64url')
  const signingInput = `${header}.${claim}`
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey)
    .toString('base64url')
  const assertion = `${signingInput}.${signature}`

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) {
    console.warn('[PUSH native] OAuth token FCM fallito:', res.status)
    return null
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) return null
  cachedToken = { value: json.access_token, expiresAt: nowSec + (json.expires_in ?? 3600) }
  return cachedToken.value
}

/**
 * Invia una notifica push nativa via FCM HTTP v1. Ritorna { ok } oppure
 * { ok:false, gone } se il token e' scaduto/non registrato (da rimuovere),
 * oppure { ok:false, error } (incluso 'fcm_non_configurato' quando mancano le
 * credenziali). Non lancia mai.
 */
export async function sendNativePush(
  token: string,
  platform: NativePlatform,
  payload: NativePushPayload
): Promise<{ ok: boolean; gone?: boolean; error?: string }> {
  if (!fcmConfigured()) return { ok: false, error: 'fcm_non_configurato' }
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return { ok: false, error: 'fcm_auth_fallita' }

    const projectId = process.env.FCM_PROJECT_ID as string
    const message = {
      message: {
        token,
        notification: { title: payload.title, body: payload.body ?? '' },
        data: { url: payload.url ?? '/', ...(payload.tag ? { tag: payload.tag } : {}) },
        // Override per piattaforma: suono di default coerente su iOS/Android.
        ...(platform === 'ios'
          ? { apns: { payload: { aps: { sound: 'default' } } } }
          : { android: { notification: { default_sound: true } } }),
      },
    }

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      }
    )
    if (res.ok) return { ok: true }
    // Token non registrato → subscription da rimuovere (come 410/404 web).
    if (res.status === 404) return { ok: false, gone: true }
    const errText = await res.text().catch(() => '')
    if (res.status === 400 && /UNREGISTERED|INVALID_ARGUMENT/i.test(errText)) {
      return { ok: false, gone: true }
    }
    return { ok: false, error: `fcm_http_${res.status}` }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'fcm_error' }
  }
}
