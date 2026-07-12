import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'
import { CONTRAST_COOKIE } from '@/lib/accessibility/cookie'
import { ContrastMenuButton } from '@/components/ui/ContrastMenuButton'

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

// Il toggle è uscito dalla login (che deve stare in una schermata sola, senza
// scroll) ed è entrato nei menu account di TUTTE le aree: prima chi era già
// dentro l'app non poteva più cambiarlo.
describe('Alto contrasto — toggle nel menu account, cablato al provider globale', () => {
  it('il toggle imposta data-contrast su <html> (provider), non solo lo stato locale', () => {
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <ContrastMenuButton />
      </AccessibilityProvider>
    )
    const toggle = screen.getByRole('button', { name: /alto contrasto/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)

    expect(document.documentElement.getAttribute('data-contrast')).toBe('high')
    expect(screen.getByRole('button', { name: /alto contrasto/i })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Login — nessun toggle contrasto in pagina', () => {
  it('la pagina di login non espone più il toggle (deve restare a tutto schermo)', () => {
    render(
      <AccessibilityProvider initialHighContrast={false}>
        <LoginPage />
      </AccessibilityProvider>
    )
    expect(screen.queryByRole('button', { name: /alto contrasto/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Accedi' })).toBeInTheDocument()
  })
})
