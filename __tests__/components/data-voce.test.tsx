import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DataVoce } from '@/components/features/primaria/DataVoce'

/**
 * Il campo «Data della prova» della primaria: la docente registra oggi l'interrogazione di
 * venerdì con la data di venerdì. Mai nel futuro, e «oggi» è quello di ROMA.
 *
 * Orologio finto sulle 23:30 UTC del 4 novembre = 00:30 del 5 novembre a Roma: con la data
 * di Greenwich il massimo sarebbe ancora il 4. Solo `Date` è finto (`toFake: ['Date']`).
 */
describe('DataVoce', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T23:30:00Z'))
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('max è oggi a Roma (il 5/11 alle 00:30)', () => {
    render(<DataVoce valore="2026-11-05" onCambia={vi.fn()} />)
    const campo = screen.getByLabelText('Data della prova') as HTMLInputElement
    expect(campo.type).toBe('date')
    expect(campo.max).toBe('2026-11-05')
    expect(campo.value).toBe('2026-11-05')
  })

  it('onCambia riceve la data scelta', () => {
    const onCambia = vi.fn()
    render(<DataVoce valore="2026-11-05" onCambia={onCambia} />)
    fireEvent.change(screen.getByLabelText('Data della prova'), { target: { value: '2026-10-30' } })
    expect(onCambia).toHaveBeenCalledTimes(1)
    expect(onCambia).toHaveBeenCalledWith('2026-10-30')
  })

  it('svuotare il campo non cancella la data: onCambia non parte', () => {
    const onCambia = vi.fn()
    render(<DataVoce valore="2026-10-30" onCambia={onCambia} />)
    fireEvent.change(screen.getByLabelText('Data della prova'), { target: { value: '' } })
    expect(onCambia).not.toHaveBeenCalled()
  })

  it('usa l’id ricevuto, così l’etichetta resta agganciata', () => {
    render(<DataVoce valore="2026-11-05" onCambia={vi.fn()} id="data-della-prova" />)
    expect(screen.getByLabelText('Data della prova').id).toBe('data-della-prova')
  })

  it('l’avviso alla famiglia solo per lo staff e solo per un giorno passato', () => {
    const { rerender } = render(<DataVoce valore="2026-10-30" onCambia={vi.fn()} />)
    // La docente: giorno passato, ma nessun avviso (la presenza del campo prova che è montato).
    expect(screen.getByLabelText('Data della prova')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()

    // Lo staff e un giorno passato: l'avviso c'è.
    rerender(<DataVoce valore="2026-10-30" onCambia={vi.fn()} avvisoStorico />)
    expect(screen.getByRole('status').textContent).toContain('senza inviare avvisi alla famiglia')

    // Lo staff e «oggi» a Roma (il 5/11): niente avviso.
    rerender(<DataVoce valore="2026-11-05" onCambia={vi.fn()} avvisoStorico />)
    expect(screen.getByLabelText('Data della prova')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
