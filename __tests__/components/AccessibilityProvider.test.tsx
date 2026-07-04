import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { useAccessibility } from '@/lib/accessibility/useAccessibility'
import { readContrastCookie, CONTRAST_COOKIE } from '@/lib/accessibility/cookie'

function Probe() {
  const { highContrast, toggle } = useAccessibility()
  return (
    <button onClick={toggle} aria-pressed={highContrast}>
      {highContrast ? 'ON' : 'OFF'}
    </button>
  )
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-contrast')
  // azzera il cookie tra i test
  document.cookie = `${CONTRAST_COOKIE}=; path=/; max-age=0`
})

describe('readContrastCookie (SSR helper)', () => {
  it('true solo se il cookie vale "high"', () => {
    expect(readContrastCookie({ get: (n) => (n === CONTRAST_COOKIE ? { value: 'high' } : undefined) })).toBe(true)
    expect(readContrastCookie({ get: () => ({ value: 'normal' }) })).toBe(false)
    expect(readContrastCookie({ get: () => undefined })).toBe(false)
  })
})

describe('AccessibilityProvider', () => {
  it('inizializza da initialHighContrast e imposta data-contrast (no flash)', () => {
    render(
      <AccessibilityProvider initialHighContrast>
        <Probe />
      </AccessibilityProvider>
    )
    expect(screen.getByRole('button').textContent).toBe('ON')
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high')
  })

  it('toggle commuta stato, data-contrast e scrive il cookie', () => {
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <Probe />
      </AccessibilityProvider>
    )
    expect(document.documentElement.getAttribute('data-contrast')).not.toBe('high')

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('button').textContent).toBe('ON')
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high')
    expect(document.cookie).toContain(`${CONTRAST_COOKIE}=high`)
  })

  it('useAccessibility fuori dal provider lancia un errore', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow()
    spy.mockRestore()
  })
})
