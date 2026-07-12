'use client'

import { Capacitor } from '@capacitor/core'

// Registrazione push NATIVA (Capacitor iOS/Android) lato client. Su web tutte le
// funzioni sono no-op: la push web resta gestita dal service worker (PushOptIn).
// L'identità è dalla sessione (cookie condiviso con la WebView); l'eventuale
// `userId` viaggia come header x-user-id di fallback legacy (identità
// localStorage del genitore) — il server preferisce comunque la sessione.

/** true se l'app gira nella shell nativa Capacitor. Su web/SSR → false. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

// Ultimo token nativo registrato in questa sessione (per la disattivazione).
let lastToken: string | null = null

/**
 * Richiede il permesso, registra la push nativa e invia il token a
 * /api/push/subscribe con la piattaforma. No-op (con esito) su web.
 */
export async function registerNativePush(userId?: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!isNativeApp()) return { ok: false, error: 'not_native' }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const perm = await PushNotifications.requestPermissions()
    if (perm.receive !== 'granted') return { ok: false, error: 'permission_denied' }

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false
      const done = (r: { ok: boolean; error?: string }) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      void PushNotifications.addListener('registration', (token) => {
        lastToken = token.value
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
          body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
        })
          .then((res) => done(res.ok ? { ok: true } : { ok: false, error: 'subscribe_failed' }))
          .catch(() => done({ ok: false, error: 'subscribe_failed' }))
      })
      void PushNotifications.addListener('registrationError', (err) => {
        done({ ok: false, error: String((err as { error?: string })?.error ?? 'registration_error') })
      })
      void PushNotifications.register()
    })
  } catch {
    return { ok: false, error: 'plugin_error' }
  }
}

/** Disattiva la push nativa: rimuove il token lato server (best-effort) e i listener. */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    if (lastToken) {
      await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(lastToken)}`, {
        method: 'DELETE',
      }).catch(() => {})
      lastToken = null
    }
    await PushNotifications.removeAllListeners()
  } catch {
    // best-effort: la disattivazione non deve mai lanciare
  }
}
