'use client'

import { createContext } from 'react'

export interface AccessibilityContextValue {
  highContrast: boolean
  setHighContrast: (value: boolean) => void
  toggle: () => void
}

export const AccessibilityContext = createContext<AccessibilityContextValue | null>(null)
