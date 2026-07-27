import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// C5 — Gate Termini in onboarding genitore.
// La UI deve avere DUE checkbox indipendenti (privacy + termini): entrambe
// bloccanti lato client. Senza i Termini niente submit; con entrambe spuntate,
// il body inviato a /api/parent/onboarding include consensi.privacy e
// consensi.termini a true (integrazione con il 422 semantico server-side, già
// coperto da __tests__/api/parent-onboarding.test.ts).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/parent/onboarding',
}))

// Identità risolta: il flusso arriva fino alla fetch quando i consensi ci sono.
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'p1', role: 'genitore', ready: true }),
}))

import ParentOnboardingPage from '@/app/(dashboard)/parent/onboarding/page'
import itNs from '../../messages/it/parentForms.json'
import enNs from '../../messages/en/parentForms.json'

const IT = itNs as Record<string, unknown>
const EN = enNs as Record<string, unknown>

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, onboarded: true }) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('i18n — chiavi consenso Termini (parentForms)', () => {
  it('it ed en espongono consensoTermini ed erroreAccettaTermini', () => {
    for (const k of ['consensoTermini', 'erroreAccettaTermini']) {
      expect(IT, `it/parentForms.json manca "${k}"`).toHaveProperty(k)
      expect(EN, `en/parentForms.json manca "${k}"`).toHaveProperty(k)
    }
  })

  it('la traduzione inglese non è un copia-incolla di quella italiana', () => {
    expect(EN.consensoTermini).not.toEqual(IT.consensoTermini)
    expect(EN.erroreAccettaTermini).not.toEqual(IT.erroreAccettaTermini)
  })
})

describe('Onboarding genitore — gate Termini (UI)', () => {
  it('mostra due checkbox indipendenti: privacy + termini', () => {
    render(<ParentOnboardingPage />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    // La seconda checkbox è quella dei Termini di servizio.
    expect(screen.getByText(/Termini di servizio/i)).toBeInTheDocument()
  })

  it('senza spuntare nulla: errore privacy, nessuna submit', async () => {
    render(<ParentOnboardingPage />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByText(/Per continuare devi accettare l/i)).toBeInTheDocument()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('con solo la privacy spuntata: blocco lato client sui Termini, nessuna submit', async () => {
    render(<ParentOnboardingPage />)
    const [privacy] = screen.getAllByRole('checkbox')
    fireEvent.click(privacy) // spunta solo privacy
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByText(/Per continuare devi accettare i Termini/i)).toBeInTheDocument()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('con entrambe spuntate: submit con consensi.privacy e consensi.termini a true', async () => {
    render(<ParentOnboardingPage />)
    const [privacy, termini] = screen.getAllByRole('checkbox')
    fireEvent.click(privacy)
    fireEvent.click(termini)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/parent/onboarding')
    const body = JSON.parse(String(init.body))
    expect(body.consensi).toMatchObject({ privacy: true, termini: true })
  })
})
