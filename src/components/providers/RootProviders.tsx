'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { NativeInit } from '@/components/providers/NativeInit'

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
      {children}
    </AccessibilityProvider>
  )
}
