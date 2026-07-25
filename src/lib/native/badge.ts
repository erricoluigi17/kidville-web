'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Badge dell'icona app = numero di notifiche non lette. Solo su piattaforma
// nativa (Capacitor iOS/Android); su web è un no-op puro. Import dinamico +
// best-effort: se il plugin manca o il permesso è negato, si degrada in
// silenzio (nessun log: è UX attesa, non un errore applicativo).

// Il permesso badge (rilevante su iOS) si chiede UNA sola volta per sessione.
let permessoRichiesto = false

/**
 * Imposta il badge dell'icona al numero di notifiche non lette. `n <= 0` pulisce
 * il badge. No-op su web e in caso di plugin/permesso non disponibili.
 */
export async function impostaBadgeNonLette(n: number): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { Badge } = await import('@capawesome/capacitor-badge')
    if (!permessoRichiesto) {
      permessoRichiesto = true
      // Il permesso è best-effort a sé: un rifiuto qui non deve impedire il
      // tentativo di set/clear (su Android non serve affatto).
      try {
        await Badge.requestPermissions()
      } catch {
        // permesso badge non concesso/non applicabile: si prova comunque
      }
    }
    if (n > 0) await Badge.set({ count: Math.trunc(n) })
    else await Badge.clear()
  } catch {
    // plugin Badge assente o permesso negato: no-op silenzioso (UX attesa)
  }
}
