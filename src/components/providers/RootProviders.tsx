'use client'

import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'

/** Compositore dei provider globali client-side (accessibilità, futuri). */
export function RootProviders({
  initialHighContrast,
  children,
}: {
  initialHighContrast: boolean
  children: React.ReactNode
}) {
  return <AccessibilityProvider initialHighContrast={initialHighContrast}>{children}</AccessibilityProvider>
}
