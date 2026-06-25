'use client'

import { useCallback, useEffect, useState } from 'react'
import { AccessibilityContext } from './context'
import { CONTRAST_COOKIE, CONTRAST_MAX_AGE } from './cookie'

/**
 * Provider globale di accessibilità (Legge Stanca / AgID). Gestisce l'alto
 * contrasto applicato a TUTTA l'app via `<html data-contrast="high">` e lo
 * persiste in un cookie SSR-safe (così il root layout lo applica già al primo
 * paint, senza flash). `initialHighContrast` arriva dal layout server-side.
 */
export function AccessibilityProvider({
  initialHighContrast = false,
  children,
}: {
  initialHighContrast?: boolean
  children: React.ReactNode
}) {
  const [highContrast, setHighContrast] = useState(initialHighContrast)

  useEffect(() => {
    const root = document.documentElement
    if (highContrast) root.setAttribute('data-contrast', 'high')
    else root.removeAttribute('data-contrast')
    document.cookie = highContrast
      ? `${CONTRAST_COOKIE}=high; path=/; max-age=${CONTRAST_MAX_AGE}; samesite=lax`
      : `${CONTRAST_COOKIE}=; path=/; max-age=0; samesite=lax`
  }, [highContrast])

  const toggle = useCallback(() => setHighContrast((v) => !v), [])

  return (
    <AccessibilityContext.Provider value={{ highContrast, setHighContrast, toggle }}>
      {children}
    </AccessibilityContext.Provider>
  )
}
