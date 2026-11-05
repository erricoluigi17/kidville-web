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

// Spec D4: il promemoria compare solo se il server dice `dateMancanti === true`. `null` (query senza
// sede o anno, sede non accessibile) e `false` non mostrano niente.
describe('ScrutinioPeriodiManager — promemoria delle date mancanti', () => {
  const PROMEMORIA = 'Mancano le date dei quadrimestri di quest’anno: senza, i voti non si collegano al quadrimestre e lo scrutinio chiuso non li protegge.'

  const periodo = { id: 'p1', nome: 'Primo quadrimestre', anno_scolastico: '2026/2027', ordine: 1, data_inizio: '2026-09-15', data_fine: '2027-01-31', attivo: true }

  function rispondeCon(corpo: Record<string, unknown>) {
    global.fetch = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ success: true, ...corpo }) }),
    ) as unknown as typeof fetch
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('promemoria con dateMancanti true', async () => {
    rispondeCon({ data: [], dateMancanti: true })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    const stato = await screen.findByRole('status')
    expect(stato.textContent).toBe(PROMEMORIA)
  })

  it('nessun promemoria con dateMancanti false', async () => {
    rispondeCon({ data: [periodo], dateMancanti: false })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    // Prima la PRESENZA di ciò che arriva con la risposta: l'assenza è vera anche mentre la fetch è in volo.
    await screen.findByText(/Primo quadrimestre/)
    expect(screen.queryByText(PROMEMORIA)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('nessun promemoria con dateMancanti null (query senza sede o anno)', async () => {
    rispondeCon({ data: [periodo], dateMancanti: null })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    await screen.findByText(/Primo quadrimestre/)
    expect(screen.queryByText(PROMEMORIA)).toBeNull()
  })

  it('la GET dichiara sede e anno, altrimenti il server non può calcolare dateMancanti', async () => {
    rispondeCon({ data: [periodo], dateMancanti: false })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    await screen.findByText(/Primo quadrimestre/)
    const url = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(url).toContain('scuolaId=s1')
    expect(url).toMatch(/annoScolastico=\d{4}\/\d{4}/)
  })
})
