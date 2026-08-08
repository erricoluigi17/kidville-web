'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { isNativeApp } from '@/lib/push/native-register'
import { setupNativeShell } from '@/lib/mobile/native-shell'
import { applicaStiloStatusBar } from '@/lib/mobile/status-bar'

// Inizializza la shell nativa Capacitor (safe-area, status bar, back button,
// deep link). No-op sul web: tutto è gated da isNativeApp(), quindi l'app web
// nel browser resta invariata. Non renderizza nulla.
let initialized = false

export function NativeInit() {
  const router = useRouter()
  const percorso = usePathname()

  useEffect(() => {
    if (initialized || !isNativeApp()) return
    initialized = true
    // Nessun setState qui: solo side-effect nativi (DOM + plugin).
    void setupNativeShell((path) => router.push(path))
  }, [router])

  // ═══ LA BARRA DI STATO CAMBIA CON LA SCHERMATA (rilievo Q31) ══════════════
  //
  // Lo stile era deciso UNA volta sola all'avvio: icone bianche sempre. Con
  // l'edge-to-edge di targetSdk 36 dietro la barra si vede il fondo della
  // pagina, quindi sulla login (crema) le icone bianche sparivano — contrasto
  // misurato 1,11:1 contro il 6,51:1 delle pagine interne.
  //
  // La decisione la prende `applicaStiloStatusBar` GUARDANDO il DOM, non un
  // elenco di rotte: qui serve solo un'occasione per rifarla a ogni percorso.
  // Il doppio `requestAnimationFrame` aspetta che la nuova schermata abbia
  // dipinto — misurare prima significherebbe leggere ancora la precedente.
  useEffect(() => {
    if (!isNativeApp()) return
    let vivo = true
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (vivo) void applicaStiloStatusBar()
      }),
    )
    return () => {
      vivo = false
      cancelAnimationFrame(id)
    }
  }, [percorso])

  return null
}
