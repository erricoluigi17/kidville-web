'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'
import { GlobalLoader } from '@/components/providers/GlobalLoader'
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister'
import { PuliziaCacheOffline } from '@/components/providers/PuliziaCacheOffline'
import { BiometricGate } from '@/components/providers/BiometricGate'

/** Compositore dei provider globali client-side (accessibilità, shell nativa). */
export function RootProviders({
  initialHighContrast,
  autenticato,
  children,
}: {
  initialHighContrast: boolean
  /** Sessione presente secondo i cookie (calcolata nel root layout server). */
  autenticato: boolean
  children: React.ReactNode
}) {
  return (
    <AccessibilityProvider initialHighContrast={initialHighContrast}>
      <NativeInit />
      {/* Registra il Service Worker (cache offline del guscio) su web e nativo. */}
      <ServiceWorkerRegister />
      {/* Scadenza della cache di lettura offline: gira una volta per avvio. */}
      <PuliziaCacheOffline />
      {/* Loader globale: overlay client fratello del contenuto (NON un boundary
          Suspense), così non interferisce con l'hydration delle pagine. */}
      <GlobalLoader />
      {/* Sblocco biometrico opt-in: passthrough puro su web, a opt-in spento e
          senza sessione; l'overlay scatta solo in useEffect (hydration-safe). */}
      <BiometricGate autenticato={autenticato}>{children}</BiometricGate>
    </AccessibilityProvider>
  )
}
