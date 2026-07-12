'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'
import { GlobalLoader } from '@/components/providers/GlobalLoader'

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
      {/* Loader globale: overlay client fratello del contenuto (NON un boundary
          Suspense), così non interferisce con l'hydration delle pagine. */}
      <GlobalLoader />
      {children}
    </AccessibilityProvider>
  )
}
