'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Badge dell'icona app = numero di notifiche non lette. Solo su piattaforma
// nativa (Capacitor iOS/Android); su web è un no-op puro. Import dinamico +
// best-effort: se il plugin manca o il permesso è negato, si degrada in
// silenzio (nessun log: è UX attesa, non un errore applicativo).
//
// QUESTO MODULO NON CHIEDE MAI IL PERMESSO NOTIFICHE, e non è un dettaglio.
// Su iOS `Badge.requestPermissions()` chiede `requestAuthorization(options:
// .badge)` — SOLO il badge — mentre `registerNativePush` chiede
// `[.alert, .sound, .badge]`. Partendo in parallelo al primo avvio (il pannello
// notifiche al mount, la registrazione push al mount) le due richieste
// competono sulla stessa autorizzazione: se vince quella badge-only, l'app
// resta autorizzata al solo badge, i banner push non arrivano MAI, e
// `PushNotifications.requestPermissions()` risponde comunque `granted`. Un
// guasto invisibile, esattamente come quello delle email raccontato in
// AGENTS.md.
//
// INVARIANTE: `registerNativePush` è l'unico punto dell'app che chiede il
// permesso notifiche.
//
// Il gate su `checkPermissions()` non è ridondante rispetto al non chiamare
// `requestPermissions()`: su iOS `BadgePlugin.set()` e `clear()` chiamano
// `requestPermissions` AL LORO INTERNO. Senza il gate, il badge tornerebbe a
// innescare il prompt. Su Android il plugin dichiara `@Permission(strings = {})`
// e `checkPermissions()` risponde sempre `granted`: il gate non cambia nulla.

/**
 * Imposta il badge dell'icona al numero di notifiche non lette. `n <= 0` pulisce
 * il badge. No-op su web, senza permesso, e in caso di plugin non disponibile.
 */
export async function impostaBadgeNonLette(n: number): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { Badge } = await import('@capawesome/capacitor-badge')
    const stato = await Badge.checkPermissions()
    // Niente permesso = niente badge. Non lo si chiede: lo chiede la push.
    if (stato?.display !== 'granted') return
    if (n > 0) await Badge.set({ count: Math.trunc(n) })
    else await Badge.clear()
  } catch {
    // plugin Badge assente o permesso negato: no-op silenzioso (UX attesa)
  }
}
