'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { isNativeApp } from '@/lib/push/native-register'
import { setupNativeShell } from '@/lib/mobile/native-shell'

// Inizializza la shell nativa Capacitor (safe-area, status bar, back button,
// deep link). No-op sul web: tutto è gated da isNativeApp(), quindi l'app web
// nel browser resta invariata. Non renderizza nulla.
let initialized = false

export function NativeInit() {
  const router = useRouter()

  useEffect(() => {
    if (initialized || !isNativeApp()) return
    initialized = true
    // Nessun setState qui: solo side-effect nativi (DOM + plugin).
    void setupNativeShell((path) => router.push(path))
  }, [router])

  return null
}
