'use client'

import { useEffect } from 'react'
import { useSessionIdentity } from '@/lib/auth/use-session-identity'
import { logClient, nomeErrore } from '@/lib/logging/client'
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
    // L'esito non tocca la UI — questo resta vero e voluto: un genitore che apre l'app non
    // deve vedere un errore perché la registrazione push è andata storta. Ma «non mostrarlo»
    // non è «non saperlo»: `registerNativePush` logga ogni ramo, e qui si chiude l'ultimo
    // buco, cioè un rifiuto della promise stessa.
    //
    // ⚠️ `attempted` è di MODULO e resta `true` per tutta la vita della pagina: se la
    // registrazione fallisce non c'è un secondo tentativo fino al prossimo avvio dell'app.
    // È il motivo per cui la riga di log qui sotto non è un di più — è l'unica traccia che
    // quel tentativo, l'unico della sessione, è andato perso.
    void registerNativePush(userId).catch((e) => {
      logClient({
        livello: 'error',
        evento: 'push',
        messaggio: `push-nativa-tentativo-fallito: ${nomeErrore(e)}`,
      })
    })
  }, [ready, userId])

  return null
}
