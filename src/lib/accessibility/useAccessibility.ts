'use client'

import { useContext } from 'react'
import { AccessibilityContext, type AccessibilityContextValue } from './context'

/** Accesso allo stato di accessibilità globale. Lancia se usato fuori dal provider. */
export function useAccessibility(): AccessibilityContextValue {
  const ctx = useContext(AccessibilityContext)
  if (!ctx) throw new Error('useAccessibility deve essere usato dentro <AccessibilityProvider>')
  return ctx
}
