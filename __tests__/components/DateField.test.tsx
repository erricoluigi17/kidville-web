import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { DateField } from '@/components/ui/DateField'

// Contratto del DateField: mostra SEMPRE gg/mm/aaaa it-IT (indipendente dal locale
// del browser, a differenza dell'<input type="date"> nativo) e scambia con la
// logica il valore ISO 'yyyy-mm-dd'.
describe('DateField — gg/mm/aaaa ↔ ISO', () => {
  it('mostra il valore ISO nel formato italiano gg/mm/aaaa', () => {
    render(<DateField value="2026-06-30" onChange={() => {}} aria-label="data" />)
    expect(screen.getByLabelText('data')).toHaveValue('30/06/2026')
  })

  it('non è un input type="date" nativo (che renderebbe mm/dd/yyyy)', () => {
    render(<DateField value="" onChange={() => {}} aria-label="data" />)
    expect(screen.getByLabelText('data')).toHaveAttribute('type', 'text')
  })

  it('emette ISO quando la data digitata è completa e valida', () => {
    const onChange = vi.fn()
    render(<DateField value="" onChange={onChange} aria-label="data" />)
    fireEvent.change(screen.getByLabelText('data'), { target: { value: '07/03/2020' } })
    expect(onChange).toHaveBeenLastCalledWith('2020-03-07')
  })

  it('emette stringa vuota finché la data è incompleta', () => {
    const onChange = vi.fn()
    render(<DateField value="" onChange={onChange} aria-label="data" />)
    fireEvent.change(screen.getByLabelText('data'), { target: { value: '07/03' } })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('si riallinea quando il valore ISO cambia dall\'esterno', () => {
    function Host() {
      const [iso, setIso] = useState('2026-01-01')
      return (
        <>
          <button onClick={() => setIso('2026-12-25')}>cambia</button>
          <DateField value={iso} onChange={setIso} aria-label="data" />
        </>
      )
    }
    render(<Host />)
    expect(screen.getByLabelText('data')).toHaveValue('01/01/2026')
    fireEvent.click(screen.getByText('cambia'))
    expect(screen.getByLabelText('data')).toHaveValue('25/12/2026')
  })
})
