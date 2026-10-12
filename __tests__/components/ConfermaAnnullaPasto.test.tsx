import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConfermaAnnullaPasto } from '@/components/features/admin/mensa/ConfermaAnnullaPasto'

/**
 * La conferma prima che la segreteria annulli un pasto (decisione del titolare,
 * 2026-10-12). Fixture FINTE, mai nomi veri.
 */

afterEach(cleanup)

describe('ConfermaAnnullaPasto', () => {
  it('chiusa non rende niente', () => {
    render(<ConfermaAnnullaPasto richiesta={null} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('aperta nomina bambino e giorno e dice che il ticket torna sul saldo', () => {
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'Bimbo Uno', dataLeggibile: 'Lunedì 12 ottobre' }} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Annullare il pasto di Bimbo Uno di Lunedì 12 ottobre? Il ticket torna sul saldo.')).toBeTruthy()
  })
  it('«Annulla il pasto» conferma, «Lascia com’è» chiude soltanto', () => {
    const onConferma = vi.fn()
    const onChiudi = vi.fn()
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'Bimbo Uno', dataLeggibile: 'oggi' }} onConferma={onConferma} onChiudi={onChiudi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Lascia com’è' }))
    expect(onChiudi).toHaveBeenCalledTimes(1)
    expect(onConferma).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Annulla il pasto' }))
    expect(onConferma).toHaveBeenCalledTimes(1)
  })
  it('con la disdetta in corso il pulsante di conferma si spegne', () => {
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'X', dataLeggibile: 'oggi' }} inCorso onConferma={vi.fn()} onChiudi={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Annulla il pasto' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('i due pulsanti hanno un touch target ≥44px', () => {
    render(<ConfermaAnnullaPasto richiesta={{ nome: 'X', dataLeggibile: 'oggi' }} onConferma={vi.fn()} onChiudi={vi.fn()} />)
    for (const n of ['Lascia com’è', 'Annulla il pasto']) {
      expect(screen.getByRole('button', { name: n }).className).toContain('min-h-[44px]')
    }
  })
})
