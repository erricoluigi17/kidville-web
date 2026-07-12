'use client'

import { useEffect } from 'react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { isNativeApp, registerNativePush } from '@/lib/push/native-register'

// Auto-registrazione della push NATIVA al primo accesso autenticato nella
// shell Capacitor: chiede il permesso di sistema e registra il token FCM/APNs
// (POST /api/push/subscribe). No-op sul web (il push web resta opt-in da
// PushOptIn) e no-op se il permesso è già stato negato (requestPermissions non
// ri-prompta). Montato nei layout parent/teacher dentro <Suspense>
// (useSessionIdentity usa useSearchParams). Non renderizza nulla.
let attempted = false

export function NativePushAutoRegister() {
  const { userId, ready } = useSessionIdentity()

  useEffect(() => {
    if (attempted || !ready || !userId || !isNativeApp()) return
    attempted = true
    // Best-effort: l'esito (permesso negato, FCM assente…) non tocca la UI.
    void registerNativePush(userId).catch(() => {})
  }, [ready, userId])

  return null
}
