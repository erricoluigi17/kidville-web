'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'
import { GlobalLoader } from '@/components/providers/GlobalLoader'
import { ServiceWorkerRegister } from '@/components/providers/ServiceWorkerRegister'
import { BiometricGate } from '@/components/providers/BiometricGate'

/** Compositore dei provider globali client-side (accessibilità, shell nativa). */
export function RootProviders({
  initialHighContrast,
  children,
}: {
  initialHighContrast: boolean
  children: React.ReactNode
}) {
  return (
    <AccessibilityProvider initialHighContrast={initialHighContrast}>
      <NativeInit />
      {/* Registra il Service Worker (cache offline del guscio) su web e nativo. */}
      <ServiceWorkerRegister />
      {/* Loader globale: overlay client fratello del contenuto (NON un boundary
          Suspense), così non interferisce con l'hydration delle pagine. */}
      <GlobalLoader />
      {/* Sblocco biometrico opt-in: passthrough puro su web e a opt-in spento;
          l'overlay bloccante scatta solo in useEffect (hydration-safe). */}
      <BiometricGate>{children}</BiometricGate>
    </AccessibilityProvider>
  )
}
