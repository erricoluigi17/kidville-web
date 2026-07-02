import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { CONTRAST_COOKIE } from '@/lib/accessibility/cookie'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: vi.fn() } }),
}))

import LoginPage from '@/app/auth/login/page'

beforeEach(() => {
  document.documentElement.removeAttribute('data-contrast')
  document.cookie = `${CONTRAST_COOKIE}=; path=/; max-age=0`
})

describe('Login — toggle alto contrasto cablato al provider globale', () => {
  it('il toggle imposta data-contrast su <html> (provider), non solo lo stato locale', () => {
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <LoginPage />
      </AccessibilityProvider>
    )
    const toggle = screen.getByRole('button', { name: /alto contrasto/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)

    expect(document.documentElement.getAttribute('data-contrast')).toBe('high')
    expect(screen.getByRole('button', { name: /alto contrasto/i })).toHaveAttribute('aria-pressed', 'true')
  })
})
