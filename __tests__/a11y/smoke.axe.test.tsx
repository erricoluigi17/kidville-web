import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { AccessibilityProvider } from '@/lib/accessibility/AccessibilityProvider'

expect.extend(toHaveNoViolations)

// Rule-set focalizzato sui componenti (le regole document-level — region,
// landmark-one-main, page-has-heading-one — non si applicano a un singolo
// componente isolato in jsdom; il color-contrast non è calcolabile senza layout).
const axeOpts = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false },
  },
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/parent',
}))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: vi.fn() } }),
}))
vi.mock('@/lib/auth/use-child-school-type', () => ({
  useChildSchoolType: () => ({ schoolType: 'primaria' }),
}))

import LoginPage from '@/app/auth/login/page'
import { OtpSignatureModal } from '@/components/features/parent/forms/OtpSignatureModal'
import BottomNav from '@/components/features/parent/BottomNav'

describe('Accessibilità — smoke jest-axe (WCAG)', () => {
  it('Login senza violazioni', async () => {
    const { container } = render(
      <AccessibilityProvider initialHighContrast={false}>
        <LoginPage />
      </AccessibilityProvider>
    )
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('Modale OTP di firma senza violazioni', async () => {
    const { container } = render(
      <OtpSignatureModal open submissionId="s-1" email="genitore@example.it" onClose={() => {}} onSigned={() => {}} />
    )
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })

  it('BottomNav senza violazioni', async () => {
    const { container } = render(<BottomNav />)
    expect(await axe(container, axeOpts)).toHaveNoViolations()
  })
})
