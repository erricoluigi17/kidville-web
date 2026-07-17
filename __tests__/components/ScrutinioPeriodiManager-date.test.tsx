import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager'

// I campi data del "Nuovo periodo" devono usare il DateField it-IT (gg/mm/aaaa),
// NON l'<input type="date"> nativo che sui browser US rende mm/dd/yyyy.
describe('ScrutinioPeriodiManager — date it-IT (niente input date nativo)', () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) }),
    ) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('non renderizza alcun <input type="date"> nativo', async () => {
    const { container } = render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    await screen.findByText('Nuovo periodo')
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(0)
  })

  it('usa il campo data it-IT (placeholder gg/mm/aaaa) per inizio e fine periodo', async () => {
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    await screen.findByText('Nuovo periodo')
    expect(screen.getAllByPlaceholderText('gg/mm/aaaa')).toHaveLength(2)
  })
})
